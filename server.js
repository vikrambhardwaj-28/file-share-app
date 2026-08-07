const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 APNI CLOUDCONVERT API KEY YAHAN PASTE KAREIN (Direct string, no spaces/brackets)
const API_KEY ='eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiZDMzMjc5OWVhZWE4OTU3MTJlNjFiZWY3MzQ5NGRjOWRhM2IwODY1NGUwNGRlN2VjZmI1ZGVjNTE2NGRhZDU3MTVmM2UzZmU1MDAxYzBjZmEiLCJpYXQiOjE3ODYwNjcxMzguMDMzNDI2LCJuYmYiOjE3ODYwNjcxMzguMDMzNDI3LCJleHAiOjQ5NDE3NDA3MzguMDI1NTQ5LCJzdWIiOiI3NjU0MjU3NSIsInNjb3BlcyI6WyJ1c2VyLnJlYWQiLCJ1c2VyLndyaXRlIiwidGFzay5yZWFkIiwidGFzay53cml0ZSIsIndlYmhvb2sucmVhZCIsIndlYmhvb2sud3JpdGUiLCJwcmVzZXQucmVhZCIsInByZXNldC53cml0ZSJdfQ.Vz_aBoLH0ioZIXm1ZMs1RJTAR9pZNSt-JPnoXxjuf3L5Pfyy0eFIX0BOdJ-tn6ouGtVBTUAY9UIu_0ZCoTw6ZUwubq5jYLWSw-obj6pZKeZcTuJmY3Lo5tWM_HnGsh8qr4h3wFoBzeHBOTX1wdIz0SF-ByRZO57KwcxLZh1jCJ6yfAtyngcMrTwIpBaQmEN8jJaxXeGf70z7MR4S1HdaL9GknopZP27UPXqEO0CfldyqzM0FlHWxDb3u5tfeX-1O3eDwEt5bkk5ig8oO1o2PGZAn5tGikVU8mzKCxyMMVdasVheIk4a6u6UfPBEEhYX_eLy44NFb2FDIA2W25ICDVsIJSd7EuYnj6VaSqj5lb-VGS8cHndjDkXK-GKe4-2jcB7_afJVV84jLY5zxw8B1ICMi0-f-4OKaWXC4dv5Sen3BLX-ORFDOfu971IuywAeljto3Y2nYRPyHwh1vzIdHKcwXQxQrVkJYNET2TOUOSZqqdySjEsMZrBo88JSFghWwtlnjmwu0TQdCsi60mlAjfsNap3br9a49KRN8U8lbHTnexY6RjVc8EO6Qdg-YVgwUy4DzYnSHYdiXGQhYx2lhAHF_NDwuu6q4VyjR_1WVeOmsF-LlP8ff2bAMl9wFLcDlQhzOhbp743SSrbJqHiH-IfO95setFSjaQ154zihv_AM';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});
const upload = multer({ storage });

const activePins = {};

function purgeFiles(pin) {
    if (activePins[pin]) {
        activePins[pin].files.forEach(file => fs.unlink(file.path, () => {}));
        delete activePins[pin];
    }
}

function downloadRemoteFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Download failed: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// Helper: Call CloudConvert Native REST API
async function cloudConvertApiRequest(endpoint, payload) {
    const response = await fetch(`https://api.cloudconvert.com/v2/${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY.trim()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || JSON.stringify(data));
    }
    return data;
}

// 1. AirShare Upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    activePins[pin] = { files: req.files, expiresAt: Date.now() + 60000, downloadCount: 0, maxDownloads: 3 };
    setTimeout(() => purgeFiles(pin), 60000);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

// 2. AirFormat Conversion Endpoint
app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace('.', '').toLowerCase();
        const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase().trim();
        const baseName = path.parse(originalName).name;
        const outputPath = path.join(uploadDir, `${Date.now()}-${baseName}.${targetFormat}`);

        // Create Job via direct REST API call
        const jobData = await cloudConvertApiRequest('jobs', {
            tasks: {
                'upload-file': { operation: 'import/upload' },
                'convert-file': {
                    operation: 'convert',
                    input: 'upload-file',
                    input_format: srcExt,
                    output_format: targetFormat
                },
                'export-file': { operation: 'export/url', input: 'convert-file' }
            }
        });

        const uploadTask = jobData.data.tasks.find(t => t.name === 'upload-file');
        const uploadUrl = uploadTask.result.form.url;
        const uploadParameters = uploadTask.result.form.parameters;

        // Upload file via FormData using native fetch
        const formData = new FormData();
        for (const [key, value] of Object.entries(uploadParameters)) {
            formData.append(key, value);
        }
        const fileBuffer = fs.readFileSync(inputPath);
        const blob = new Blob([fileBuffer]);
        formData.append('file', blob, originalName);

        await fetch(uploadUrl, { method: 'POST', body: formData });

        // Poll for job completion
        let completedJob = null;
        const jobId = jobData.data.id;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
                headers: { 'Authorization': `Bearer ${API_KEY.trim()}` }
            });
            const statusData = await statusRes.json();
            if (statusData.data.status === 'finished') {
                completedJob = statusData.data;
                break;
            } else if (statusData.data.status === 'error') {
                throw new Error('CloudConvert job failed.');
            }
        }

        const exportTask = completedJob.tasks.find(t => t.name === 'export-file');
        const fileUrl = exportTask.result.files[0].url;

        await downloadRemoteFile(fileUrl, outputPath);
        fs.unlink(inputPath, () => {});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}.${targetFormat}`, size: fs.statSync(outputPath).size }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[Convert Direct API Error]:', err.message || err);
        return res.status(500).json({ success: false, message: `Conversion Error: ${err.message}` });
    }
});

// 3. AirCompress Endpoint
app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const baseName = path.parse(originalName).name;
        const ext = path.extname(originalName);
        const outputPath = path.join(uploadDir, `${Date.now()}-compressed-${baseName}${ext}`);

        const jobData = await cloudConvertApiRequest('jobs', {
            tasks: {
                'upload-file': { operation: 'import/upload' },
                'optimize-file': { operation: 'optimize', input: 'upload-file', profile: 'web' },
                'export-file': { operation: 'export/url', input: 'optimize-file' }
            }
        });

        const uploadTask = jobData.data.tasks.find(t => t.name === 'upload-file');
        const uploadUrl = uploadTask.result.form.url;
        const uploadParameters = uploadTask.result.form.parameters;

        const formData = new FormData();
        for (const [key, value] of Object.entries(uploadParameters)) {
            formData.append(key, value);
        }
        const fileBuffer = fs.readFileSync(inputPath);
        const blob = new Blob([fileBuffer]);
        formData.append('file', blob, originalName);

        await fetch(uploadUrl, { method: 'POST', body: formData });

        let completedJob = null;
        const jobId = jobData.data.id;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
                headers: { 'Authorization': `Bearer ${API_KEY.trim()}` }
            });
            const statusData = await statusRes.json();
            if (statusData.data.status === 'finished') {
                completedJob = statusData.data;
                break;
            } else if (statusData.data.status === 'error') {
                throw new Error('Optimization failed.');
            }
        }

        const exportTask = completedJob.tasks.find(t => t.name === 'export-file');
        const fileUrl = exportTask.result.files[0].url;

        await downloadRemoteFile(fileUrl, outputPath);
        fs.unlink(inputPath, () => {});

        const compressedSize = fs.statSync(outputPath).size;
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}-compressed${ext}`, size: compressedSize }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, originalSize: req.file.size, compressedSize, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[Compress Direct API Error]:', err.message || err);
        return res.status(500).json({ success: false, message: 'Compression failed.' });
    }
});

app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    return res.json({ success: true, files: record.files.map((file, index) => ({ index, originalname: file.originalname, size: file.size })) });
});

app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    const targetFile = record.files[parseInt(index, 10)];
    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));