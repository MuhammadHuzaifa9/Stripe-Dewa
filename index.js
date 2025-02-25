const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const morgan = require('morgan');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config(); // Load environment variables

// Initialize Firebase Admin SDK

admin.initializeApp({
    credential: admin.credential.cert({
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Fix newline issue
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI,
        token_uri: process.env.FIREBASE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    })
});

const db = admin.firestore();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // Use environment variable

// Middleware
app.use(express.json());
app.use(morgan('dev'));

// Explicit CORS Handling
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // Allow any frontend (For testing)
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200); // Handle preflight requests
    }
    
    next();
});

// Stripe Checkout Session Endpoint
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { productName, amount, userEmail, userName } = req.body;

        if (!productName || !amount || !userEmail || !userName) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: userEmail,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: productName },
                    unit_amount: amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: process.env.SUCCESS_URL,
            cancel_url: process.env.CANCEL_URL,
            metadata: { userEmail, userName, productName }
        });

        res.json({ sessionId: session.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Webhook to Handle Payment Success
app.post('/webhook', (req, res) => {
    let event;
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let rawBody = '';

    req.on('data', (chunk) => {
        rawBody += chunk;
    });

    req.on('end', async () => {
        try {
            event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
        } catch (err) {
            console.error('Webhook Error:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userEmail = session.metadata.userEmail;
            const userName = session.metadata.userName;
            const productName = session.metadata.productName;
            const amountPaid = session.amount_total / 100;

            try {
                await db.collection('orders').add({
                    userEmail,
                    userName,
                    productName,
                    amountPaid,
                    status: 'Paid',
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log('✅ Order saved successfully in Firestore');
            } catch (error) {
                console.error('🔥 Error saving order:', error);
            }
        }

        res.json({ received: true });
    });
});

// Set port dynamically for Vercel
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

module.exports = app;
