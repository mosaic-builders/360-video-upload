
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]:-$0}"; )" &> /dev/null && pwd 2> /dev/null; )";

for VIDEO_FILE_NAME in "$@"
do
    mkdir -p "transcribe"

    AUDIO_FILE_NAME="$VIDEO_FILE_NAME.mp3"
    TIMESTAMP=$(date +%s)
    S3_PATH="s3://mosaic-hypervisor/transcribe/input/$AUDIO_FILE_NAME"
    JOB_NAME="$AUDIO_FILE_NAME.$TIMESTAMP"
    JOB_NAME_FILE_NAME="transcribe/$AUDIO_FILE_NAME.$TIMESTAMP.job.json"
    JOB_OUTPUT_KEY="transcribe/output/$JOB_NAME.json"
    TRANSCRIPT_URL="https://mosaic-hypervisor.s3.us-west-1.amazonaws.com/$JOB_OUTPUT_KEY"

    rm -f "transcribe/$AUDIO_FILE_NAME"

    echo "Step 1. Extracting Audio"
    ffmpeg -i "$VIDEO_FILE_NAME" -q:a 0 "transcribe/$AUDIO_FILE_NAME" 2> /dev/null

    echo "Step 2. Uploading to S3"
    aws s3 cp "transcribe/$AUDIO_FILE_NAME" "$S3_PATH"

    echo "Step 3. Start Transcribe"
    OUTPUT=$(aws transcribe start-transcription-job \
        --language-code 'en-US' \
        --media-format 'mp3' \
        --transcription-job-name "$JOB_NAME" \
        --media "{\"MediaFileUri\": \"$S3_PATH\"}" \
        --output-bucket-name 'mosaic-hypervisor' \
        --output-key "$JOB_OUTPUT_KEY" \
        --no-cli-pager
    )
    
    echo "$OUTPUT"

    echo $OUTPUT > "$JOB_NAME_FILE_NAME"

done




