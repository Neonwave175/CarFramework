# Car Framework
Unified framework for all RPI and UNO based cars that require CV

## main.py
Captures the frame, puts it in a async q to allow other functions from other files to use it

Also calls the functions from other files and puts them in a async loop

## sender.py
Compresses the file into AVIF format, encrypt it using encryption.py and sends it and also runs the detection loop

## encryption.py
Generates keys using ML-KEM and signs the keys with ML-DSA to verrify source and authenticity, then uses AES256-GMCSIV to encrypt the image. Same stac, but in reverse for decryption

## trackhuman.py
uses the tracked location values to send controlls. This can be completely swapped out for other projects with other needs

# Models:
yolov8n-pose and yolov26n converted to NCNN from pytorch for speed reasons
Project of distilling v26l into v8n has been canceled due to the vastly superior performance of v26n compared to tuned v8n

# License:
GNU LGPL-3.0
