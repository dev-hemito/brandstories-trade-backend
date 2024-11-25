const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// Google Sheets Setup
async function getSheet() {
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc.sheetsByIndex[0];
}

// Email Configuration
const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.in',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_EMAIL?.trim(),
        pass: process.env.SMTP_PASSWORD?.trim(),
    }
});

// PhonePe Payment Gateway Class
class PhonePeClient {
    constructor() {
        this.merchantId = process.env.PHONEPE_MID;
        this.saltKey = process.env.PHONEPE_SALTKEY;
        this.saltIndex = 1;
        this.apiUrl = process.env.PHONEPE_API_URL;
    }

    generateChecksum(payload, apiEndpoint) {
        const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const base64Payload = Buffer.from(payloadString).toString('base64');
        const string = `${base64Payload}${apiEndpoint}${this.saltKey}`;
        const sha256 = crypto.createHash('sha256').update(string).digest('hex');
        return `${sha256}###${this.saltIndex}`;
    }

    async initiatePayment(paymentData) {
        const payload = {
            merchantId: this.merchantId,
            merchantTransactionId: paymentData.orderId.substring(0, 35),
            merchantUserId: paymentData.email.substring(0, 50),
            amount: Math.round(parseFloat(paymentData.amount) * 100),
            redirectUrl: `${process.env.FRONTEND_URL}/payment-status`,
            redirectMode: "POST",
            callbackUrl: `${process.env.BACKEND_URL}/api/payment-callback`,
            mobileNumber: paymentData.phone,
            paymentInstrument: {
                type: "PAY_PAGE"
            }
        };

        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const checksum = this.generateChecksum(payload, "/pg/v1/pay");

        const response = await fetch(`${this.apiUrl}/pay`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': checksum
            },
            body: JSON.stringify({ request: base64Payload })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Payment initialization failed');
        return data;
    }

    async verifyPayment(merchantTransactionId) {
        const checksum = this.generateChecksum(
            merchantTransactionId,
            `/pg/v1/status/${this.merchantId}/${merchantTransactionId}`
        );

        const response = await fetch(
            `${this.apiUrl}/status/${this.merchantId}/${merchantTransactionId}`,
            {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-VERIFY': checksum,
                    'X-MERCHANT-ID': this.merchantId
                }
            }
        );

        const data = await response.json();
        return {
            success: data.success,
            status: data.code === 'PAYMENT_SUCCESS' ? 'success' : 'failed',
            transactionId: data.data?.transactionId,
            details: data
        };
    }
}

// Check Registration Endpoint
app.post('/api/check-registration', async (req, res) => {
    try {
        const { email, phone } = req.body;
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        
        const existingEmail = rows.some(row => row.get('email') === email);
        const existingPhone = rows.some(row => row.get('phone') === phone);

        if (existingEmail || existingPhone) {
            return res.status(400).json({
                error: 'Already registered',
                message: `${existingEmail ? 'Email' : 'Phone number'} is already registered`
            });
        }

        res.json({ success: true, message: 'Registration available' });
    } catch (error) {
        res.status(500).json({ error: 'Verification failed', message: error.message });
    }
});

// Initialize Payment Endpoint
app.post('/api/initialize-payment', async (req, res) => {
    try {
        const { name, email, phone, amount, address, package: packageType } = req.body;

        const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const ticketNumber = `BSKTETC24${randomNum}`;
        const orderId = `ORDER_${Date.now()}_${randomNum}`;

        const phonePe = new PhonePeClient();
        const paymentData = { orderId, email, amount, phone, ticketNumber };

        // Store registration data temporarily
        global.pendingRegistrations = global.pendingRegistrations || new Map();
        global.pendingRegistrations.set(orderId, {
            name, email, phone, address, package: packageType,
            ticketNumber, amount, timestamp: new Date().toISOString()
        });

        const paymentResponse = await phonePe.initiatePayment(paymentData);

        // Send initial email
        await transporter.sendMail({
            from: { name: 'The Brand Stories', address: process.env.SMTP_EMAIL },
            to: email,
            subject: 'Registration Initiated - Trading Summit',
            html: `
                <h1>Registration Initiated!</h1>
                <p>Dear ${name},</p>
                <p>Your registration for the Trading Summit is being processed.</p>
                <p>Ticket number: <strong>${ticketNumber}</strong></p>
                <p>Please complete the payment to confirm your registration.</p>
                <p>This ticket will be activated after successful payment.</p>
            `
        });

        res.json({
            success: true,
            paymentUrl: paymentResponse?.data?.instrumentResponse?.redirectInfo?.url,
            orderId,
            ticketNumber
        });

    } catch (error) {
        res.status(500).json({ error: 'Payment initialization failed', message: error.message });
    }
});

// Payment Callback Endpoint
app.post('/api/payment-callback', async (req, res) => {
    try {
        const { merchantTransactionId, transactionId, status } = req.body;
        const registrationData = global.pendingRegistrations.get(merchantTransactionId);

        if (!registrationData) {
            return res.status(404).json({ error: 'Registration data not found' });
        }

        if (status === 'success') {
            const sheet = await getSheet();
            await sheet.addRow({
                ...registrationData,
                paymentStatus: 'Success',
                transactionId,
                orderId: merchantTransactionId
            });

            // Send confirmation email
            await transporter.sendMail({
                from: { name: 'The Brand Stories', address: process.env.SMTP_EMAIL },
                to: registrationData.email,
                subject: 'Registration Confirmed - Trading Summit',
                html: `
                    <h1>Registration Confirmed!</h1>
                    <p>Dear ${registrationData.name},</p>
                    <p>Your registration for the Trading Summit has been confirmed!</p>
                    <p>Details:</p>
                    <ul>
                        <li>Ticket Number: <strong>${registrationData.ticketNumber}</strong></li>
                        <li>Package: ${registrationData.package}</li>
                        <li>Order ID: ${merchantTransactionId}</li>
                        <li>Transaction ID: ${transactionId}</li>
                    </ul>
                    <p>Keep this ticket number safe for entry.</p>
                `
            });

            global.pendingRegistrations.delete(merchantTransactionId);
        }

        res.json({ success: true, status });

    } catch (error) {
        res.status(500).json({ error: 'Callback processing failed', message: error.message });
    }
});

// Payment Status Check Endpoint
app.post('/api/check-payment-status', async (req, res) => {
    try {
        const { orderId } = req.body;
        const phonePe = new PhonePeClient();
        const status = await phonePe.verifyPayment(orderId);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: 'Status check failed', message: error.message });
    }
});

app.get("/", (req, res) => {
    res.send("Welcome to the brandstories ");
  });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


module.exports = app