const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();

const port = process.env.PORT || 3000;
const stripe = require('stripe')(process.env.STRIPE_SECRET);



//firebase
// var admin = require("firebase-admin");
// var serviceAccount = require("./firebaseAdmin.json");
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });



//middle
app.use(express.json());
app.use(cors());

//middle 2
// const verifyFBToken = async (req, res, next) => {
//     console.log('header from middle= ', req.headers?.authorization)
//     const token = req.headers.authorization;

//     if (!token) {
//         return res.status(401).send({ message: 'unauthorize access' })
//     }

//     try {
//         const tokenId = token.split(' ')[1]
//         const decoded = await admin.auth().verifyIdToken(tokenId)
//         console.log('decoded in token', decoded)

//         //reload dile token er shb data pawa jabe 

//         req.decodedEmail = decoded.email
//         next()
//     }
//     catch (err) {
//         return res.status(401).send({ message: 'unauthorize access' })
//     }

// }

const client = new MongoClient(process.env.MONGODB_URI);

async function connectToMongoDB() {
    try {
        await client.connect();

        console.log("MongoDB connected successfully!");

        const db = client.db("parkDB");

        // Test collection
        const usersCollection = db.collection("users");
        const partnersCollection = db.collection("partners");
        const paymentsCollection = db.collection("payments");

        //users
        app.post('/users', async (req, res) => {
            const user = req.body
            user.role = "user"
            user.createdAt = new Date()
            const email = user.email
            const userExist = await usersCollection.findOne({ email })
            if (userExist) {
                return res.send({ message: 'user exist' })
            }
            const result = await usersCollection.insertOne(user)
            res.send(result)
        })


        //admin management

        app.get("/users", async (req, res) => {
            const query = {}
            const cursor = usersCollection.find(query).sort({ createdAt: -1 })
            const result = await cursor.toArray()

            res.send(result)
        })

        app.patch('/users/:id/role', async (req, res) => {
            const roleInfo = req.body;

            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const updateDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await usersCollection.updateOne(query, updateDoc);

            res.send(result);
        })

        //secure users
        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            res.send({ role: user?.role || 'user' })
        })
        //partners 

        app.post('/partners', async (req, res) => {
            const partner = req.body;
            partner.status = 'pending';
            partner.createdAt = new Date();

            const result = await partnersCollection.insertOne(partner);
            res.send(result)
        })

        app.get('/partners', async (req, res) => {
            const query = {};
            if (req.query.status) {
                query.status = req.query.status
            }
            const options = { sort: { createdAt: -1 } }
            const cursor = partnersCollection.find(query, options)
            const result = await cursor.toArray();
            res.send(result)
        })
        //partner status+role update
        //status update
        app.patch("/partner/:id", async (req, res) => {
            const id = req.params.id;
            const { status, email } = req.body;
            const query = { _id: new ObjectId(id) };

            const updatedDoc = {
                $set: {
                    status
                },
            };
            const result = await partnersCollection.updateOne(query, updatedDoc);

            //role update
            let userResult = null;
            if (status === "approved") {
                userResult = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            role: "partner",
                        },
                    }
                );
            } else if (status === "rejected") {
                userResult = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            role: "user",
                        },
                    }
                );
            }

            res.send({
                success: result.matchedCount > 0,
                result,
                userResult,
            });
        });



        //get all lot
        app.get("/approved-partners", async (req, res) => {
            const lots = await partnersCollection
                .find({ status: "approved" })
                .toArray();

            res.send(lots);
        });

        app.get('/application/my', async (req, res) => {
            const query = {}
            const { email } = req.query
            if (email) {
                query.email = email
            }
            const cursor = partnersCollection.find(query)
            const result = await cursor.toArray()
            res.send(result)
        })





        // booking and Stripe Checkout 
        app.post('/create-checkout-session', async (req, res) => {
            const bookingData = req.body;

            const amount = Math.round(Number(bookingData.totalPrice) * 100);

            // 1. Save booking in payments collection first
            const payment = {
                lotId: bookingData.lotId,
                lotName: bookingData.lotName,
                user_email: bookingData.user_email,
                startTime: bookingData.startTime,
                endTime: bookingData.endTime,
                V_type: bookingData.V_type,
                V_number: bookingData.V_number,
                totalPrice: Number(bookingData.totalPrice),
                currency: 'bdt',
                paymentStatus: 'pending',
                transactionId: null,
                createdAt: new Date()
            };

            const result = await paymentsCollection.insertOne(payment);

            // 2. Create Stripe Checkout Session
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'bdt',
                            unit_amount: amount,
                            product_data: {
                                name: bookingData.lotName
                            }
                        },
                        quantity: 1
                    }
                ],
                customer_email: bookingData.user_email,
                mode: 'payment',
                metadata: {
                    paymentId: result.insertedId.toString(),
                    lotId: bookingData.lotId,
                    user_email: bookingData.user_email
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            });



            res.send({
                success: true,
                url: session.url,
                paymentId: result.insertedId
            });
        });


        // Update payment after successful Stripe Checkout
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;

            if (!sessionId) {
                return res.status(400).send({
                    success: false,
                    message: 'Session ID is required'
                });
            }

            const session = await stripe.checkout.sessions.retrieve(sessionId);

            if (session.payment_status !== 'paid') {
                return res.send({
                    success: false,
                    message: 'Payment not completed'
                });
            }

            const paymentId = session.metadata.paymentId;



            // Find the exact payment document created before checkout
            const payment = await paymentsCollection.findOne({
                _id: new ObjectId(paymentId),

            });

            if (!payment) {
                return res.status(404).send({
                    success: false,
                    message: 'Booking not found'
                });
            }

            // Avoid creating a new tracking ID on repeated requests
            if (payment.paymentStatus === 'paid') {
                return res.send({
                    success: true,
                    message: 'Payment already completed',
                    paymentInfo: payment
                });
            }

            const paymentInfo = {
                amount: session.amount_total / 100,
                currency: session.currency,
                customerEmail: session.customer_email,
                lotId: session.metadata.lotId,
                lotName: payment.lotName,
                transactionId: session.payment_intent,
                paymentStatus: session.payment_status,
                status: "waiting",
                paidAt: new Date()
            };

            const result = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(paymentId),

                    paymentStatus: 'pending'
                },
                {
                    $set: paymentInfo
                }
            );

            const updatedPayment = await paymentsCollection.findOne({
                _id: new ObjectId(paymentId)
            });

            res.send({
                success: result.modifiedCount > 0,
                paymentInfo: updatedPayment
            });
        });


        // my bookings

        app.get('/my-bookings', async (req, res) => {
            const { email } = req.query;

            const result = await paymentsCollection.find({
                user_email: email,
                paymentStatus: "paid",
                status: {
                    $in:
                        ["waiting",
                            "check-in req",
                            "check-in confirm",
                            "check-out req",]
                }
            }).sort({ createdAt: -1 }).toArray();

            res.send(result);
        });

        // Get bookings from check-in request until checkout confirmation
        app.get('/payments', async (req, res) => {
            const result = await paymentsCollection.find({
                paymentStatus: "paid",
                status: {
                    $in: [
                        "waiting",
                        "check-in req",
                        "check-in confirm",
                        "check-out req",
                        "check-out confirm"
                    ]
                }
            }).sort({ createdAt: -1 }).toArray();

            res.send(result);
        });
      

        //check in request
        app.patch('/payments/check-in-request/:id', async (req, res) => {
            const { id } = req.params;
            const result = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    paymentStatus: 'paid',
                    status: 'waiting'
                },
                {
                    $set: {
                        status: 'check-in req',
                        checkInRequestedAt: new Date()
                    }
                }
            );
            res.send({
                success: true,
                message: 'Check-in request submitted successfully'
            });
        });



        ////update as check_in_confirm
        app.patch('/payments/check-in-confirm/:id', async (req, res) => {
            const { id } = req.params;

            const result = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    paymentStatus: "paid",
                    status: "check-in req"
                },
                {
                    $set: {
                        status: "check-in confirm",
                        checkInConfirmedAt: new Date()
                    }
                }
            );

            res.send({
                success: result.modifiedCount > 0
            });
        });


        //check out request
        app.patch('/payments/check-out-request/:id', async (req, res) => {
            const { id } = req.params;
            const result = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    paymentStatus: 'paid',
                    status: 'check-in confirm'
                },
                {
                    $set: {
                        status: 'check-out req',
                        checkOutRequestedAt: new Date()
                    }
                }
            );
            res.send({
                success: true,
                message: 'Check-in request submitted successfully'
            });
        });

        ////update as check-out confirm
        app.patch('/payments/check-out-confirm/:id', async (req, res) => {
            const { id } = req.params;

            const result = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    paymentStatus: "paid",
                    status: "check-out req"
                },
                {
                    $set: {
                        status: "check-out confirm",
                        checkOutConfirmedAt: new Date()
                    }
                }
            );

            res.send({
                success: result.modifiedCount > 0,
                message: result.modifiedCount > 0
                    ? "Check-out confirmed successfully"
                    : "Checkout request not found"
            });
        });






    } catch (error) {
        console.error("MongoDB connection failed:", error);
    }
}

// Routes
app.get("/", (req, res) => {
    res.send("running park");
});

// Start server
async function startServer() {
    await connectToMongoDB();

    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

startServer();