import asyncio
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from ultralytics import YOLO

MODE = "both"
IMGSZ = 320
CENTER = (0.35, 0.65)
MODELS = {
    "detect": "yolov26n_ncnn_model",
    "pose": "yolov8n-pose_ncnn_model",
}


def zone_of(cx):
    if cx < CENTER[0]:
        return "left"
    if cx > CENTER[1]:
        return "right"
    return "center"


class Analyser:
    def __init__(self, mode=MODE, imgsz=IMGSZ, conf=0.4, draw_zones=True):
        self.imgsz = imgsz
        self.conf = conf
        self.draw_zones = draw_zones
        self.tasks = ["detect", "pose"] if mode == "both" else [mode]
        self.models = {t: YOLO(MODELS[t], task=t) for t in self.tasks}
        self.last = []
        self._pool = ThreadPoolExecutor(max_workers=1)
        self._infer(np.zeros((imgsz, imgsz, 3), np.uint8))
        self.last = []

    def _infer(self, frame):
        h, w = frame.shape[:2]
        canvas = frame
        dets = []
        for t in self.tasks:
            r = self.models[t](frame, imgsz=self.imgsz, conf=self.conf, verbose=False)[0]
            canvas = r.plot(img=canvas, boxes=(t == "detect"))
            if t != self.tasks[0] or r.boxes is None:
                continue
            names = self.models[t].names
            for box, score, cls in zip(
                r.boxes.xyxy.cpu().numpy(),
                r.boxes.conf.cpu().numpy(),
                r.boxes.cls.cpu().numpy(),
            ):
                x1, y1, x2, y2 = box
                cx = float((x1 + x2) / 2 / w)
                dets.append({
                    "label": names[int(cls)],
                    "conf": float(score),
                    "box": [float(x1), float(y1), float(x2), float(y2)],
                    "cx": cx,
                    "zone": zone_of(cx),
                    "height": float((y2 - y1) / h),
                })
        if self.draw_zones:
            for f in CENTER:
                x = int(f * w)
                cv2.line(canvas, (x, 0), (x, h), (0, 255, 255), 1)
        self.last = dets
        return canvas

    async def __call__(self, frame):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._infer, frame)
