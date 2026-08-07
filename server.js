const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const CloudConvert = require('cloudconvert');

const app = express();
const PORT = process.env.PORT || 3000;

// API Key from Render Environment Variable
const API_KEY = process.env.CLOUDCONVERT_API_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiODMxODk4ZjlmNDcyNDAwMGU3YzgyMDdhMzg2MWZmOGI2NGExYTRhYjViMTM2YWIxZGI0MmEwNWUwNzA1Yjc3MzExYWNmYTU1MzA2Njc5ZjAiLCJpYXQiOjE3ODYwNjYzNDUuOTY0ODE3LCJuYmYiOjE3ODYwNjYzNDUuOTY0ODE4LCJleHAiOjQ5NDE3Mzk5NDUuOTU3NjI4LCJzdWIiOiI3NjU0MjU3NSIsInNjb3BlcyI6WyJ1c2VyLnJlYWQiLCJ1c2VyLndyaXRlIl19.IbCF5P9yXcE5jY1ioZQ3XRDvkfgcdHsp7GK4XhzfFEa9h8kGoIdDQEAheGUiQLnxlEdib9tCt1vqSodfhqhyrHQuvObX91jA5kBhqs3_7adpUPgi8mrW7saeSxWrq6n4bQGjg8GWgVGtdm4PoCwJWEu6IjJeZFUCdiCBgEcLzfN1aO1QNFb-JrsNnX9DxgljKr8AouBqQHEGSXmuhHPwAulJPSaSVyss0_QdL92vgwu580DZ3zpzv_wdGnS3qikjKCnZfy7v0utJACFdktsLW9zbfeeSF2d4JpPrM5bh0PgSapE2-RaJ8LnNuEjno2zwDRb4vJvUwHn_gcZ8ReE1FBPGXkTAnEYxcLrgqSTsYuIeBHR0lZ8TknCNTiS1toixNVRieRnBeMseC2ofQi5uU719X0cIUgONZbOybIVJQ3g4mp6-ILI-Lv4DCaaBPyewo-KUaC0hvo0ZNUftc691y2P_0sXcZNFooTFxDPxzP9lFqcQ7gGS4j0WdMhfQtkeEnBHssgrKL649wpSNGZSSyeRID1iTS5DGGNsKddXhdrjNkRxIa91lJONAadeqPgnSRPW8bVVrxM0pkSmzezBO_nMBSfK3_YZK6XyLNiVM6xpmICN5Ygkl0UZy233aNM5pgJDtCTf9ewF1JgFAblMk1AEhf0edkKmHY5xo5IzzFT0';

let cloudConvert = null;
if (API_KEY && API_KEY !== 'YOUR_CLOUDCONVERT_API_KEY_HERE') {
    cloudConvert = new CloudConvert(API_KEY);
}

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
                return reject(new Error(`Download failed with status: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// 1. AirShare - Standard Multi-File Upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    activePins[pin] = { files: req.files, expiresAt: Date.now() + 60000, downloadCount: 0, maxDownloads: 3 };
    setTimeout(() => purgeFiles(pin), 60000);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

// 2. AirFormat - Multi-Format Conversion Endpoint
app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace('.', '').toLowerCase();
        const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase().trim();
        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-${baseName}.${targetFormat}`;
        const outputPath = path.join(uploadDir, outputFileName);

        if (!cloudConvert) {
            return res.status(500).json({ success: false, message: 'CloudConvert API Key missing in environment variables.' });
        }

        // Job payload with explicit input_format and output_format
        let job = await cloudConvert.jobs.create({
            tasks: {
                'upload-my-file': { operation: 'import/upload' },
                'convert-my-file': {
                    operation: 'convert',
                    input: 'upload-my-file',
                    input_format: srcExt,
                    output_format: targetFormat
                },
                'export-my-file': { operation: 'export/url', input: 'convert-my-file' }
            }
        });

        const uploadTask = job.tasks.find(t => t.name === 'upload-my-file');
        await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(inputPath), originalName);
        job = await cloudConvert.jobs.wait(job.id);

        const exportTask = job.tasks.find(t => t.name === 'export-my-file');
        if (exportTask && exportTask.result && exportTask.result.files && exportTask.result.files[0]) {
            await downloadRemoteFile(exportTask.result.files[0].url, outputPath);
            fs.unlink(inputPath, () => {});
        } else {
            throw new Error('Conversion export returned empty result.');
        }

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
        console.error('[Convert Cloud Error]:', err.message || err);
        return res.status(500).json({ success: false, message: `Conversion failed: ${err.message || 'API error'}` });
    }
});

// 3. AirCompress - High-Ratio Document & Image Optimization Endpoint
app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const baseName = path.parse(originalName).name;
        const ext = path.extname(originalName);
        const outputFileName = `${Date.now()}-compressed-${baseName}${ext}`;
        const outputPath = path.join(uploadDir, outputFileName);

        if (!cloudConvert) {
            return res.status(500).json({ success: false, message: 'CloudConvert API Key missing.' });
        }

        let job = await cloudConvert.jobs.create({
            tasks: {
                'upload-file': { operation: 'import/upload' },
                'optimize-file': { operation: 'optimize', input: 'upload-file', profile: 'web' },
                'export-file': { operation: 'export/url', input: 'optimize-file' }
            }
        });

        const uploadTask = job.tasks.find(t => t.name === 'upload-file');
        await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(inputPath), originalName);
        job = await cloudConvert.jobs.wait(job.id);

        const exportTask = job.tasks.find(t => t.name === 'export-file');
        if (exportTask && exportTask.result && exportTask.result.files && exportTask.result.files[0]) {
            await downloadRemoteFile(exportTask.result.files[0].url, outputPath);
            fs.unlink(inputPath, () => {});
        } else {
            throw new Error('Optimization export returned empty result.');
        }

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const compressedSize = fs.statSync(outputPath).size;
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}-compressed${ext}`, size: compressedSize }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, originalSize: req.file.size, compressedSize, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[Compress Cloud Error]:', err.message || err);
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