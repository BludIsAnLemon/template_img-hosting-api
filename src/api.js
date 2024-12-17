(async function() {
    require('dotenv').config()
    const express = require('express')
    const { rateLimit } = require('express-rate-limit')
    const parseDataURI = require('parse-data-uri')
    const fs = require('fs/promises')
    const crypto = require('crypto')
    const sharp = require('sharp')
    const mime = require('mime-types')
    const path = require('path')

    const data_uri_regex = new RegExp(/^(data:)([\w\/\+]+);(charset=[\w-]+|base64).*,(.*)/gi)

    const valid_mimetypes = ['image/png', 'image/jpeg', 'image/webp']

    const uploadsDir = path.resolve(__dirname, '../uploads');
    if (!(await fs.access(uploadsDir))) {
        await fs.mkdir(uploadsDir, { recursive: true })
    }

    const metadataPath = './upload_dates.json'

    const api = express()

    api.use(express.json())
    api.use('/uploads', express.static('uploads'))

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 25,
        message: 'Too many uploads for this IP. Please try again in 15 minutes.'
    })

    api.use(limiter)

    api.get('/', (req, res) => {
        res.send('This is the homepage. Send a post request to /upload to upload a file.')
    })

    api.post('/upload/', async (req, res) => {
        const {datauri} = req.body
        if(!datauri || !data_uri_regex.test(datauri)) send404(res, 'Please send a valid data.uri!')

        const parsedDataURI = parseDataURI(datauri)
        if(parsedDataURI.data.byteLength > 15 * 1024 * 1024) send404(res, 'File is larger than 15MB!')
        if(!valid_mimetypes.includes(parsedDataURI.mimeType)) send404(res, 'Unsupported file type!')
        
        let fileName;

        do {
            fileName = `${crypto.randomBytes(8).toString('hex')}.${mime.extension(parsedDataURI.mimeType)}`
        } while(await fs.access(path.join(uploadsDir, fileName)).catch(() => false))

        const processedBuffer = await reduceQuality(parsedDataURI.data)
        await fs.writeFile(path.join(uploadsDir, fileName), processedBuffer)

        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'))
        metadata[fileName] = new Date()

        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))
        
        res.status(200)
        res.end(`Image uploaded successfully to ${fileName}.`)
    })

    api.listen(process.env.PORT, () => {
        console.log(`API running on port ${process.env.PORT}.`)
    })

    /**
     * Sends a 404 request to a request
     * @param {express.Response} res 
     * @param {string} msg 
     */
    function send404(res, msg) {
        res.status(404)
        res.send(msg)
    }

    /**
     * reduces a quality of a image from buffer
     * @returns {Buffer}
     * @param {Buffer} inputBuffer 
     */
    async function reduceQuality(inputBuffer) {
        try {
            const metadata = await sharp(inputBuffer).metadata()
            const format = metadata.format

            const options = format === 'png' ? { compressionLevel: 9 } : { quality: 20 }

            const outputBuffer = await sharp(inputBuffer)
                .toFormat(format, options)
                .toBuffer()
            
            return outputBuffer
        } catch {
            return inputBuffer
        }
    }

    async function runCleanup() {
        try {
            const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'))

            const now = Date.now()

            for(const [filename, uploadDateStr] of Object.entries(metadata)) {
                const uploadDate = new Date(uploadDateStr)

                const ageInMS = now - uploadDate

                if(ageInMS > 30 * 24 * 60 * 60 * 1000) {
                    const filePath = path.join(uploadsDir, filename)

                    await fs.unlink(filePath)
                    console.log(`File deleted: ${filename}`)

                    delete metadata[filename]
                }
            }
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))
            console.log('File cleanup completed.')
        } catch(error) {
            console.error(`File cleanup error: ${error}`)
        }
    }
    setInterval(async() => {await runCleanup()}, 60 * 60 * 1000)
})()