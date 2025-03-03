import os
from flask import Flask, Response, request, jsonify, make_response
from werkzeug.utils import secure_filename
import boto3
from botocore.config import Config
from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime, timedelta
import io
from flask_cors import CORS
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
CORS(app)
app.config['CORS_HEADERS'] = 'Content-Type'

# Configure S3 client for Cloudflare R2
s3_client = boto3.client(
    's3',
    region_name='auto',
    endpoint_url=os.getenv('CLOUDFLARE_R2_ENDPOINT'),
    aws_access_key_id=os.getenv('S3_ACCESS_Key'),
    aws_secret_access_key=os.getenv('S3_SECRET_ACCESS_KEY'),
    config=Config(s3={'addressing_style': 'path'})
)

# Global counters and pause state
global_upload_counter = 0
global_upload_size = 0  # in MB
pause_uploads_downloads = False

def check_and_pause_uploads_downloads():
    global pause_uploads_downloads
    if global_upload_counter >= 25 or global_upload_size >= 100:
        pause_uploads_downloads = True
        print('Uploads/Downloads paused for 1 hour due to high traffic.')
        scheduler = BackgroundScheduler()
        scheduler.add_job(
            lambda: globals().update(pause_uploads_downloads=False),
            'date',
            run_date=datetime.now() + timedelta(hours=1)
        )
        scheduler.start()
        print('Uploads/Downloads resumed.')

def generate_access_code(length=4):
    import secrets
    return secrets.token_hex(length)[:length]

def delete_old_files():
    thirty_minutes_ago = datetime.now() - timedelta(minutes=30)
    try:
        response = s3_client.list_objects_v2(Bucket=os.getenv('S3_BUCKET_NAME'))
        if 'Contents' not in response:
            print("No old files to delete.")
            return
        to_delete = [
            {'Key': obj['Key']}
            for obj in response['Contents']
            if obj['LastModified'].replace(tzinfo=None) < thirty_minutes_ago
        ]
        if to_delete:
            s3_client.delete_objects(
                Bucket=os.getenv('S3_BUCKET_NAME'),
                Delete={'Objects': to_delete, 'Quiet': False}
            )
            print(f"Deleted {len(to_delete)} old files.")
        else:
            print("No old files to delete.")
    except Exception as e:
        print(f"Error in deleting old files: {e}")

@app.route('/upload', methods=['POST'])
def upload_file():
    global global_upload_counter, global_upload_size
    if pause_uploads_downloads:
        return jsonify({'error': 'Service temporarily unavailable due to high traffic.'}), 503
    
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded.'}), 400
    
    file = request.files['file']
    # Although the secret word is sent, the server no longer uses it.
    secret_word = request.form.get('secretWord')
    file_type = request.form.get('type')
    iv = request.form.get('iv')  # Provided from client (Base64)
    salt = request.form.get('salt')  # Provided from client (Base64)
    
    if not file or not secret_word or not iv or not salt:
        return jsonify({'error': 'Missing file, secret word, iv or salt'}), 400
    
    file_data = file.read()
    global_upload_counter += 1
    global_upload_size += len(file_data) / (1024 * 1024)
    
    check_and_pause_uploads_downloads()
    
    access_code = generate_access_code()
    extension = secure_filename(file.filename).rsplit('.', 1)[-1] if '.' in file.filename else 'bin'
    
    s3_client.put_object(
        Bucket=os.getenv('S3_BUCKET_NAME'),
        Key=access_code,
        Body=file_data,
        ServerSideEncryption='AES256',
        ContentType='application/octet-stream',
        Metadata={
            'filetype': file_type or 'unknown',
            'iv': iv,
            'salt': salt,
            'extension': extension
        }
    )
    
    return jsonify({'message': 'File uploaded successfully', 'key': access_code})

@app.route('/retrieve', methods=['GET'])
def retrieve_file():
    if pause_uploads_downloads:
        return jsonify({'error': 'Service temporarily unavailable due to high traffic.'}), 503
    
    access_code = request.args.get('accessCode')
    if not access_code:
        return jsonify({'error': 'Access code is required'}), 400

    try:
        s3_response = s3_client.get_object(Bucket=os.getenv('S3_BUCKET_NAME'), Key=access_code)
        encrypted_data = s3_response['Body'].read()
        metadata = s3_response['Metadata']
        print(f"Metadata: {metadata}")  # Debug log
        iv = metadata.get('iv', '').replace(' ', '+')
        salt = metadata.get('salt', '').replace(' ', '+')

        response = Response(encrypted_data, mimetype='application/octet-stream')
        response.headers['X-IV'] = iv
        response.headers['X-SALT'] = salt
        response.headers['X-EXTENSION'] = metadata.get('extension', 'bin')
        response.headers['Access-Control-Expose-Headers'] = 'X-IV, X-SALT, X-EXTENSION'
        return response
    except Exception as e:
        print(f"Error: {e}")
        return Response("Server error", status=500)


@app.route('/')
def home():
    return "Hello", 200

# Schedule periodic tasks
scheduler = BackgroundScheduler()
scheduler.add_job(delete_old_files, 'interval', minutes=30)
scheduler.add_job(
    lambda: globals().update(global_upload_counter=0, global_upload_size=0),
    'interval',
    minutes=30
)
scheduler.start()

if __name__ == '__main__':
    port = 4000
    print(f"Server is running on port {port}.")
    app.run(host='0.0.0.0', port=port)
