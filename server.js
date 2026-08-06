const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const CloudConvert = require('cloudconvert');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 CLOUDCONVERT API KEY (task.read & task.write scopes)
const CLOUDCONVERT_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiNzY2ODBiNjU0Y2I2ZTA5NjJjMjNhZTJlZTRmNTg4MjE5MDMyZjFkNmFjY2EzYzk2ZWFlNTVkMmNkNGFhNzFiMmU0MWI2MmQwOGYyOGIxMGMiLCJpYXQiOjE3ODYwMzkwNzMuODMzMjM4LCJuYmYiOjE3ODYwMzkwNzMuODMzMjM5LCJleHAiOjQ5NDE3MTI2NzMuODI2MzE1LCJzdWIiOiI3NjU0MjU3NSIsInNjb3BlcyI6WyJ1c2VyLnJlYWQiLCJ1c2VyLndyaXRlIiwidGFzay5yZWFkIiwidGFzay53cml0ZSJdfQ.km17Mcu9IkHfcsdxHlXSEJhkeOS3wF8kHlGOeuF_C09IFJksOZZ08FZtlyfL5KYIhts0AcXNwT72ExY3dxkuGP5SSyIQOqC0xjdXnEhwX43gKJEuB34MO-SayvkPrELkEms4cbRh4bb0ZbTiy4ZS-VGOke3FqeRwRrNdKpYgnqVFYtaptjHp8mv9HdJyWju5KzStCTJBULfSh4wt1eiiTjkTPxLGrnNjbJRDEGOs3v6PK5vhdRk9ul8IVuz9hSsO73anEKZNhAJOqnMNiSSryv-LM0ip9kBlGu9XP0Ak_u9Wi41u1XWKMWmupfn15xNDTYhZYSmIcb-1WGHesk-4QtVqhuK4H_fh8vZFwqsIg6V2f8szgQtSBRS_Tf0WddD9dM3ISfLNa1OnHgVG_5HzOH5HPXMvpZ3TvpwHCOOopX0TeLVAV8N3oKXeGHqXLT3HvFQxUZA_92d9BKHtlfju8zaThf_Z-6Fnpl7m_mGDb3WozkppUwd6iXB6x_ndUVsmPf7o6TdlsXExofwNoNnzE897CmiT4pQ7urGTGkoviGdy_0V7JxgMgmKNLyJpcufAiAiL-lTS9VkacAmKE_01uTwPx3SZBXSDOdTcccHwI5F2pKna5A2kTYtgRi2R3bRFPyGmrowCrSqC2aJns_yvcmEToz0NZ46-By5KU93UFxo';
let cloudConvert = null;
if (CLOUDCONVERT_API_KEY && CLOUDCONVERT_API_KEY !== 'YOUR_CLOUDCONVERT_API_KEY_HERE') {
    cloudConvert = new CloudConvert(CLOUDCONVERT_API_KEY);
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
        activePins[pin].files.forEach(file => {
            fs.unlink(file.path, () => {});
        });
        delete activePins[pin];
    }
}

// 1. Standard Multi-File Upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 60000;

    activePins[pin] = {
        files: req.files,
        expiresAt: Date.now() + expiryDurationMs,
        downloadCount: 0,
        maxDownloads: 3
    };

    setTimeout(() => purgeFiles(pin), expiryDurationMs);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

// 2. AirCompress Endpoint
app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const baseName = path.parse(req.file.originalname).name;
        const ext = path.extname(req.file.originalname);
        const outputFileName = `${Date.now()}-compressed-${baseName}${ext}`;
        const outputPath = path.join(uploadDir, outputFileName);

        if (cloudConvert) {
            let job = await cloudConvert.jobs.create({
                tasks: {
                    'upload-file': { operation: 'import/upload' },
                    'optimize-file': { operation: 'optimize', input: 'upload-file', profile: 'web' },
                    'export-file': { operation: 'export/url', input: 'optimize-file' }
                }
            });

            const uploadTask = job.tasks.find(t => t.name === 'upload-file');
            await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(inputPath), req.file.originalname);
            job = await cloudConvert.jobs.wait(job.id);

            const exportTask = job.tasks.find(t => t.name === 'export-file');
            const fileUrl = exportTask.result.files[0].url;

            const response = await fetch(fileUrl);
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(outputPath, Buffer.from(buffer));
        } else {
            fs.copyFileSync(inputPath, outputPath);
        }

        const compressedSize = fs.statSync(outputPath).size;
        fs.unlink(inputPath, () => {});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expiryDurationMs = 60000;

        activePins[pin] = {
            files: [{
                path: outputPath,
                originalname: `${baseName}-compressed${ext}`,
                size: compressedSize
            }],
            expiresAt: Date.now() + expiryDurationMs,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), expiryDurationMs);
        return res.json({ success: true, pin, originalSize: req.file.size, compressedSize, expiresInSeconds: 60 });

    } catch (err) {
        console.error('Compress Error:', err);
        return res.status(500).json({ success: false, message: 'Compression failed.' });
    }
});

// 3. AirFormat Endpoint
app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase().trim();
        const inputPath = req.file.path;
        const baseName = path.parse(req.file.originalname).name;
        const outputFileName = `${Date.now()}-${baseName}.${targetFormat}`;
        const outputPath = path.join(uploadDir, outputFileName);

        if (cloudConvert) {
            let job = await cloudConvert.jobs.create({
                tasks: {
                    'upload-my-file': { operation: 'import/upload' },
                    'convert-my-file': { operation: 'convert', input: 'upload-my-file', output_format: targetFormat },
                    'export-my-file': { operation: 'export/url', input: 'convert-my-file' }
                }
            });

            const uploadTask = job.tasks.find(t => t.name === 'upload-my-file');
            await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(inputPath), req.file.originalname);
            job = await cloudConvert.jobs.wait(job.id);

            const exportTask = job.tasks.find(t => t.name === 'export-my-file');
            const fileUrl = exportTask.result.files[0].url;

            const response = await fetch(fileUrl);
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(outputPath, Buffer.from(buffer));
        } else {
            fs.copyFileSync(inputPath, outputPath);
        }

        fs.unlink(inputPath, () => {});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expiryDurationMs = 60000;

        activePins[pin] = {
            files: [{
                path: outputPath,
                originalname: `${baseName}.${targetFormat}`,
                size: fs.statSync(outputPath).size
            }],
            expiresAt: Date.now() + expiryDurationMs,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), expiryDurationMs);
        return res.json({ success: true, pin, expiresInSeconds: 60 });

    } catch (err) {
        console.error('Convert Error:', err);
        return res.status(500).json({ success: false, message: 'Format conversion failed.' });
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