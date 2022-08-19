import fetch from 'node-fetch'
import AWS from 'aws-sdk'
import fs from 'fs'
import { clone, endsWith, find, lowerCase, startsWith } from 'lodash'
import { mkdir, readdir, writeFile } from 'fs/promises'
import ProgressiveSession from '@api.video/nodejs-client/lib/model/ProgressiveSession'
import Video from '@api.video/nodejs-client/lib/model/Video'
import Chapter from '@api.video/nodejs-client/lib/model/Chapter'
import { WriteStream } from 'fs'
import ApiVideoClient from '@api.video/nodejs-client'
const createCsvWriter = require('csv-writer').createObjectCsvWriter
const createReadStream = require('fs').createReadStream
const createWriteStream = require('fs').createWriteStream
const gpmfExtract = require('gpmf-extract')
const goproTelemetry = require(`gopro-telemetry`)
require('dotenv').config()

const CHUNK_SIZE = 40 * 1024 * 1024 // 40MB

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let argv = clone(process.argv)
argv.shift()
argv.shift()

let [dir, ...videos] = argv

// set up s3 instance
const s3 = new AWS.S3()
var credentials = new AWS.SharedIniFileCredentials()
AWS.config.credentials = credentials

const uploadFileToS3 = async (presignedUploadUrl: string, file: Buffer) => {
  return await fetch(presignedUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: file,
  })
}

const secsToTime = (seconds: number) => {
  const d = new Date(seconds * 1000).toISOString().substring(11, 23)
  return d
}

const extractLot = (filename: string): number => {
  return parseInt(filename.replace('.mp4', '').split('_')[1])
}

const extractDate = (filename: string): string => {
  return filename.replace('.mp4', '').split('_').slice(2, 5).join('_')
}

const constructChapters = (chapters: any[]): string => {
  let chapterStr = 'WEBVTT\n'
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    const chapterStart = secsToTime(chapter.startTime)
    const chapterEnd =
      i === chapters.length - 1
        ? secsToTime(chapter.endTime)
        : secsToTime(chapters[i + 1].startTime)
    const content = chapter.content
    chapterStr += `\n${i}\n${chapterStart} --> ${chapterEnd}\n${content}\n`
  }

  return chapterStr
}

type VideoData = {
  date: string
  development?: string
  lot: number
  base_url?: string
  url: string
  room?: string
  timestamp_url?: string
  timestamp?: number
}

type videoDataObj = {
  csv: VideoData
  s3: VideoData[]
}

const writeVideoDataCSV = async (filename: string, records: VideoData[]) => {
  const csvWriter = createCsvWriter({
    path: filename,
    header: [
      { id: 'lot', title: 'Lot #' },
      { id: 'date', title: 'Date' },
      { id: 'url', title: 'Video URL' },
    ],
  })

  csvWriter
    .writeRecords(records) // returns a promise
    .then(() => {
      console.log(`✅ Video data written to ${filename}`)
    })
}

const writeVideoDataS3 = async (keyName: string) => {
  // generate presigned url
  const url = s3.getSignedUrl('putObject', {
    Bucket: 'mosaic-360-videos',
    ContentType: 'application/json',
    Key: keyName,
    Expires: 60 * 5,
  })

  var dataFile = fs.readFileSync(`${dir}/s3_data.json`)

  // upload file to s3 bucket
  uploadFileToS3(url, dataFile)
    .then((res) => {
      if (res.status == 200) {
        console.log(`✅ Successfully uploaded ${keyName} to S3\n`)
      }
    })
    .catch((error) => console.log(error))
}

const progressiveUploadVideo = async (
  filename: string,
  chapters: any[],
  s3Output: WriteStream,
  lastVideo: boolean
): Promise<videoDataObj> => {
  let videoDataCSV!: VideoData
  let videoDataS3: VideoData[] = []

  console.log(`⏳ Uploading ${filename}\n`)

  const path = `${dir}/${filename}`

  const file = fs.readFileSync(path)

  let latitude = 0
  let longitude = 0
  gpmfExtract(file)
    .then((extracted: any) => {
      goproTelemetry(
        extracted,
        {
          stream: ['GPS5'],
          GPS5Fix: 3,
          GPS5Precision: 200,
          WrongSpeed: 100,
        },
        (telemetry: any) => {
          const streamSamples = telemetry['1']?.streams?.GPS5?.samples
          if (streamSamples) {
            const gps =
              streamSamples[Math.floor(streamSamples.length / 2)].value
            latitude = gps[0]
            longitude = gps[1]
            console.log('📍 Extracted GPS data')
          }
        }
      )
    })
    .catch((error: any) => console.error(error))

  await mkdir(`${dir}/chapters`, { recursive: true })
  const chapterFileName = `${dir}/chapters/${filename.replace(
    '.mp4',
    '.chapters.vtt'
  )}`

  // write to chapter .vtt file
  await writeFile(chapterFileName, constructChapters(chapters))

  const fileToChunks = async (filePath: string): Promise<Buffer[]> => {
    // create read stream for file
    const rs = createReadStream(filePath, {
      highWaterMark: CHUNK_SIZE,
      encoding: 'binary',
    })

    return new Promise((resolve, reject) => {
      const chunkArray: Buffer[] = []

      rs.on('data', (chunk: Buffer) => {
        const writeStream = createWriteStream(
          `${dir}/chunk_${chunkArray.length}_${filename}`,
          {
            encoding: 'binary',
          }
        )
        chunkArray.push(chunk)
        writeStream.write(chunk)
      })
      rs.on('error', (error: any) => {
        console.log('File upload error:', filename)
        reject(error)
      })
      return rs.on('end', () => {
        resolve(chunkArray)
      })
    })
  }

  const uploadInChunks = async (
    uploadSession: ProgressiveSession<Video>,
    chunkArray: Buffer[]
  ): Promise<Video> => {
    let uploadObj!: Video
    let currentChunkIndex = 0

    for (const currentChunk of chunkArray) {
      // create progress bar to show upload status
      process.stdout.write(
        `\tChunk ${currentChunkIndex + 1}/${chunkArray.length} (${
          currentChunk.length
        } bytes)`
      )

      const chunkFileName = `${dir}/chunk_${currentChunkIndex}_${filename}`

      if (currentChunk.length < CHUNK_SIZE) {
        // if current chunk is smaller than the chunk size, it's the last chunk
        uploadObj = await uploadSession.uploadLastPart(chunkFileName)
      } else {
        await uploadSession.uploadPart(chunkFileName)
      }

      try {
        // delete chunk file
        fs.unlinkSync(chunkFileName)
      } catch (err) {
        console.error(err)
      }

      process.stdout.write(' ✔️\n')
      currentChunkIndex++
    }
    return uploadObj
  }

  // instantiate api.video client with given chunk size
  const client = new ApiVideoClient({
    apiKey: process.env.API_VIDEO_PROD_KEY,
    chunkSize: CHUNK_SIZE,
  })

  // variable to store video ID after video container is created
  let videoID = ''

  // create video container
  await client.videos
    .create({
      title: filename,
      panoramic: true,
    })
    // convert mp4 file into individual chunk files
    .then((container: Video) => {
      videoID = container.videoId
      console.log('✅ Created new video with ID', videoID)
      return fileToChunks(path)
    })
    // progressively upload chunk files to api.video
    .then((chunkArray: Buffer[]) => {
      const uploadSession: ProgressiveSession<Video> =
        client.videos.createUploadProgressiveSession(videoID)
      return uploadInChunks(uploadSession, chunkArray)
    })
    // add chapters to videos and construct video data object
    .then((upload: Video) => {
      console.log('✅ Successfully uploaded video to api.video')
      const d: VideoData = {
        lot: extractLot(filename),
        date: extractDate(filename),
        url: upload.assets?.player || 'No video URL found',
      }

      videoDataCSV = d

      chapters.forEach((chapter, index) => {
        const videoDataS3Obj = {
          ...d,
          base_url: 'https://embed.api.video/vod/',
          room: chapter.content,
          timestamp: chapter.startTime,
          timestamp_url: `${d.url}#t=${Math.floor(chapter.startTime)}`,
          development: 'Jasper',
          lat: latitude,
          long: longitude,
        }

        videoDataS3.push(videoDataS3Obj)

        s3Output.write(JSON.stringify(videoDataS3Obj))

        if (!(lastVideo && index === chapters.length - 1)) s3Output.write(',')
      })

      return client.chapters.upload(upload.videoId, 'en', chapterFileName)
    })
    .then((chapters: Chapter) => {
      console.log(`✅ Chapters added to video`)
    })
    .catch((error: any) => console.log(error))
    .finally(() => {
      console.log('Upload workflow over')
    })

  return {
    csv: videoDataCSV,
    s3: videoDataS3,
  }
}

async function main() {
  let files = await readdir(`${dir}/transcribe`)
  let jobs = files.filter((file) => endsWith(file, '.job.json'))

  let CSVData: VideoData[] = []
  let s3Data: VideoData[] = []

  var s3Output = fs.createWriteStream(`${dir}/s3_data.json`, {
    flags: 'w',
    encoding: 'utf8',
  })

  s3Output.write('[')

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i]
    let jobName = find(jobs, (job) => startsWith(job, video))

    let jobParts = jobName!.split('.')
    jobParts.pop()
    jobParts.pop()
    let timestamp = jobParts.pop()
    let transcriptUrl = `https://mosaic-hypervisor.s3.us-west-1.amazonaws.com/transcribe/output/${video}.mp3.${timestamp}.json`
    let url = transcriptUrl

    let transcript: any = {}
    let attempt = 1

    while (true) {
      let response = await fetch(url)
      if (response.status === 200) {
        let json = await response.json()
        transcript = json
        break
      }

      console.warn(
        `Transcription not done. Trying again in 5 seconds. (Attempt ${attempt}) - ${url}`
      )
      attempt += 1

      await sleep(5000)
    }

    let items = transcript.results.items

    items = items.filter((item: any) => {
      return item.type === 'pronunciation'
    })

    items = items.filter((item: any) => {
      let confidence = item.alternatives[0].confidence
      confidence = parseFloat(confidence)
      return confidence > 0.9
    })

    items = items.map((item: any) => {
      let output: any = {}
      output.startTime = parseFloat(item.start_time)
      output.endTime = parseFloat(item.end_time)
      output.content = lowerCase(item.alternatives[0].content)

      return output
    })

    let chapters: any = []
    let chapter: any = null

    for (let item of items) {
      if (chapter === null) {
        chapter = item
        chapters.push(chapter)
      } else {
        if (item.startTime - chapter.endTime < 1) {
          chapter.content += ' ' + item.content
        } else {
          chapter = item
          chapters.push(chapter)
        }
      }
    }

    let subs: Record<string, string> = {
      panting: 'pantry',
    }

    for (let chapter of chapters) {
      let keys = Object.keys(subs)
      if (keys.includes(chapter.content)) {
        chapter.content = subs[chapter.content]
      }
    }

    let approvedCommands: Array<string> = [
      'front',
      'entry',
      'hall ',
      'door',
      'living',
      'study',
      'great',
      'room',
      'bathroom',
      'bedroom',
      'den',
      'laundry',
      'master',
      'garage',
      'powder',
      'closet',
      'kitchen',
      'pantry',
      'toilet',
      'ac',
      'a c',
      'panel',
      'electric',
    ]

    chapters = chapters.filter((chapter: any) => {
      let content: string = chapter.content
      if (content.split(' ').length >= 3) return false

      for (let approvedCommand of approvedCommands) {
        if (content.includes(approvedCommand)) {
          return true
        }
      }

      return false
    })

    console.log(
      `\n\n========== VIDEO ${i + 1} of ${videos.length} ==========\n`
    )

    const lastVideo = i === videos.length - 1 ? true : false
    const videoDataObj = await progressiveUploadVideo(
      video,
      chapters,
      s3Output,
      lastVideo
    )

    CSVData.push(videoDataObj.csv)
    s3Data = s3Data.concat(videoDataObj.s3)
  }

  s3Output.write(']')
  s3Output.end()

  // write video data .csv file
  await writeVideoDataCSV(`${dir}/video_data.csv`, CSVData)
    .then(() => {
      // upload video data to S3 bucket
      const s3KeyName = `video_data_${extractDate(videos[0])}.json`
      writeVideoDataS3(s3KeyName)
    })
    .catch((error) => {
      console.log(error)
    })
    .finally(() => {
      console.log(`\n\n========== ALL VIDEOS UPLOADED ==========\n\n`)
    })
}

main()
