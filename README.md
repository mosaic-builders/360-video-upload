# 360-video-upload
Transcribe, chapter, encode, and upload 360-degree mp4 files. See [Notion documentation](https://www.notion.so/mosaicbuilders/Hyper-Vision-360-Video-08ac02ec7852437098dc2dc3a4697b22) for more details about 360 walkthrough / upload workflows.

### Getting Started

First, create a `.env` file in the root directory and configure it with values from the api.video dashboard [dashboard](https://dashboard.api.video/apikeys)
Toggle between production and sandbox mode to get the API keys, then add them to the `.env` file: 

```
API_VIDEO_PROD_KEY = {production key}
API_VIDEO_DEV_KEY = {sandbox key}
```

Next, install necessary dependencies:

```bash
npm install
# or
yarn install
```

It is also necessary to have `ffmpeg` installed on your machine.

Next, configure AWS using the AWS command-line tools (see Notion documentation for more details)

To run the scripts, enter the following Terminal commands after you `cd` into a directory of `.mp4` videos exported from GoPro Media Player (see Notion documentation for more details about the export workflow):

1. Run `bash path/to/repo/bin/transcribe.start.sh *.mp4`
2. Wait a few seconds, and run `bash path/to/repo/bin/transcribe.parse.sh *.mp4`

### Notes:
- By default, the videos will be uploaded to api.video in the production dashboard. To use sandbox mode instead, change `parse.ts` to set `API_VIDEO_KEY = process.env.API_VIDEO_DEV_KEY` near the top of the file
- Currently, the development for all videos is set to "Jasper"
- TODO: If necessary, save raw transcript data (from AWS transcribe) to S3 in `mosaic-360-videos` bucket
