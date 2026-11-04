const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
// const cron = require("node-cron");

const app = express();

const port = process.env.PORT || 3000;
const stripe = require('stripe')(process.env.STRIPE_SECRET);



//firebase

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
// const serviceAccount = require("./firebaseAdmin.json");

// const serviceAccount = require("./firebase-admin-key.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);
initializeApp({
    credential: cert(serviceAccount),
});

//middle
app.use(express.json());
app.use(cors());

//middle 2
const verifyFBToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "unauthorize access" });
    }

    try {
        const tokenId = authHeader.split(" ")[1];
        const decoded = await getAuth().verifyIdToken(tokenId);
        req.decodedEmail = decoded.email;
        next();
    } catch (err) {
        return res.status(401).send({ message: "unauthorize access" });
    }
};

const client = new MongoClient(process.env.MONGODB_URI);

async function connectToMongoDB() {
    try {
        await client.connect();

        console.log("MongoDB connected successfully!");

        const db = client.db("parkDB");

        // Test collection
        const usersCollection = db.collection("users");
        const partnersCollection = db.collection("partners");
        const bookingsCollection = db.collection("bookings");
        const paymentsCollection = db.collection("payments");

        //role based token
        const verifyAdmin = async (req, res, next) => {
            const user = await usersCollection.findOne({ email: req.decodedEmail });
            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };

        const verifyPartner = async (req, res, next) => {
            const user = await usersCollection.findOne({ email: req.decodedEmail });
            if (!user || user.role !== "partner") {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };

        //users
        app.post("/users", verifyFBToken, async (req, res) => {
            const user = req.body;
            user.email = req.decodedEmail;
            user.role = "user";
            user.createdAt = new Date();

            const userExist = await usersCollection.findOne({ email: user.email });
            if (userExist) {
                return res.send({ message: "user exist" });
            }
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });


        //admin management

        app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
            const query = {}
            const cursor = usersCollection.find(query).sort({ createdAt: -1 })
            const result = await cursor.toArray()

            res.send(result)
        })


        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const roleInfo = req.body;
            if (!["user", "partner", "admin"].includes(role)) {
                return res.status(400).send({ message: "Invalid role" });
            }
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
        app.get("/users/:email/role", verifyFBToken, async (req, res) => {
            const email = req.params.email;

            if (email !== req.decodedEmail) {
                return res.status(403).send({ message: "forbidden access" });
            }
            const user = await usersCollection.findOne({ email });
            res.send({ role: user?.role || "user" });
        });

        //partners 

        app.post('/partners', verifyFBToken, async (req, res) => {
            const partner = req.body;
            partner.email = req.decodedEmail;
            partner.status = 'pending';
            partner.createdAt = new Date();

            const result = await partnersCollection.insertOne(partner);
            res.send(result)
        })

        //list applications
        app.get('/partners', verifyFBToken, verifyAdmin, async (req, res) => {
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
        app.patch("/partner/:id", verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const { status, email } = req.body;
            if (!["approved", "rejected", "pending"].includes(status)) {
                return res.status(400).send({ message: "Invalid status" });
            }
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




        // Get all active approved lots
        app.get("/approved-partners", async (req, res) => {
            const lots = await partnersCollection
                .find({
                    status: "approved",
                    lotStatus: { $ne: "disabled" },
                })
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


        ////USER API START
        //booking post
        app.post("/bookings", verifyFBToken, async (req, res) => {
            const createdAt = new Date();

            const bookingData = {
                ...req.body,
                user_email: req.decodedEmail,
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000),
                status: "waiting for check-in",
                paymentStatus: "unpaid",
            };

            const result = await bookingsCollection.insertOne(bookingData);
            res.send({
                success: true, bookingId: result.insertedId, expiresAt: bookingData.expiresAt,
            });
        });
        //get my bookings
        app.get("/my-booking", verifyFBToken, async (req, res) => {
            await expireBookings();
          
            const bookings = await bookingsCollection
                .find({
                    user_email: req.decodedEmail,
                    status: { $nin: ["expired", "check-out confirmed"] }
                })
                .sort({ createdAt: -1 })
                .toArray();

            res.send(bookings);
        });

        // Expire bookings every minute
        // cron.schedule("* * * * *", async () => {
        //     const result = await bookingsCollection.updateMany(
        //         {

        //             status: "waiting for check-in",
        //             expiresAt: { $lte: new Date() }
        //         },
        //         {
        //             $set: {
        //                 status: "expired",
        //                 expiredAt: new Date()
        //             }
        //         }
        //     );

        //     if (result.modifiedCount > 0) {
        //         console.log(`${result.modifiedCount} booking(s) expired`);
        //     }
        // });
        const expireBookings = () =>
    bookingsCollection.updateMany(
        {
            status: "waiting for check-in",
            expiresAt: { $lte: new Date() },
        },
        {
            $set: {
                status: "expired",
                expiredAt: new Date(),
            },
        }
    );
        //check in request
        app.patch("/booking/check-in-request/:id", verifyFBToken, async (req, res) => {
                await expireBookings(); 
            const { id } = req.params;

            const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
            const result = await bookingsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    user_email: req.decodedEmail,
                    status: "waiting for check-in"
                },
                {
                    $set: {
                        status: "check-in requested",
                        checkInRequestedAt: new Date()
                    }
                }
            );

            res.send({ success: true, message: "Check-in requested successfully" });
        });
        ///PARTNER API

        const getPartnerLotIds = async (email) => {
            const lots = await partnersCollection.find({ email, status: "approved" })
                .project({ _id: 1 })
                .toArray();
            return lots.map((l) => l._id.toString());
        };

        const ownerFilter = async (email) =>
            email ? { lotId: { $in: await getPartnerLotIds(email) } } : {};

        ///upcoming req
        app.get("/partner/upcoming-requests", verifyFBToken, verifyPartner, async (req, res) => {
            await expireBookings();  
            const { email } = req.query;
            if (!email) return res.status(400).send({ message: "email required" });

            const lotIds = await getPartnerLotIds(req.decodedEmail);

            const result = await bookingsCollection.find({
                lotId: { $in: lotIds },
                status: {
                    $in: [
                        "waiting for check-in",
                        "check-in requested",
                        "check-in confirm",
                        "check-out requested",
                        "payment pending",
                        "paid",
                        "payment verifying",
                    ],
                },
            })
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });

        /////update as check-in confirm
        app.patch('/check-in-confirm/:id', verifyFBToken,
            verifyPartner, async (req, res) => {
                const { id } = req.params;
                const { email } = req.decodedEmail;

                const result = await bookingsCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        paymentStatus: "unpaid",
                        status: "check-in requested",
                        ...(await ownerFilter(email)),
                    },
                    {
                        $set:
                        {
                            status: "check-in confirm",
                            checkInConfirmedAt: new Date()
                        }
                    }
                );

                res.send({ success: result.modifiedCount > 0 });
            });




        //check-out req

        app.patch("/booking/check-out-request/:id", verifyFBToken, async (req, res) => {
            const { id } = req.params;

            const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
            const result = await bookingsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    user_email: req.decodedEmail,
                    status: "check-in confirm"
                },
                {
                    $set: {
                        status: "check-out requested",
                        checkOutRequestedAt: new Date()
                    }
                }
            );

            res.send({ success: true, message: "Check-out requested successfully" });
        });


        ////update as check-out confirm & payment req
        app.patch('/check-out-confirm/payment-request/:id', verifyFBToken,
            verifyPartner, async (req, res) => {
                const { id } = req.params;
                const { email } = req.decodedEmail;

                const result = await bookingsCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        paymentStatus: "unpaid",
                        status: "check-out requested",
                        ...(await ownerFilter(email))
                    },
                    {
                        $set: {
                            status: "payment pending",
                            paymentRequestedAt: new Date()
                        }
                    }
                );

                res.send({
                    success: result.modifiedCount > 0,
                    message: result.modifiedCount > 0
                        ? "payment requested successfully"
                        : "payment request not found"
                });
            });


        // Stripe Checkout 
        app.post("/create-checkout-session", async (req, res) => {
            const { bookingId } = req.body;

            const booking = await bookingsCollection.findOne({
                _id: new ObjectId(bookingId)
            });

            if (!booking) {
                return res.status(404).send({ message: "Booking not found" });
            }

            const partner = await partnersCollection.findOne({
                _id: new ObjectId(booking.lotId),
                status: "approved"
            });

            if (!partner) {
                return res.status(404).send({ message: "Partner not found" });
            }

            if (booking.status !== "payment pending") {
                return res.status(400).send({
                    message: "Booking is not ready for payment"
                });
            }

            const startTime = new Date(booking.checkInConfirmedAt);
            const endTime = new Date(booking.paymentRequestedAt);

            const totalMinutes = Math.ceil(
                (endTime - startTime) / (1000 * 60)
            );

            const pricePerMinute = Number(booking.pricePerMinute);
            const totalPrice = totalMinutes * pricePerMinute;

            if (
                totalMinutes <= 0 ||
                !Number.isFinite(totalPrice) ||
                totalPrice <= 0
            ) {
                return res.status(400).send({
                    message: "Invalid parking amount"
                });
            }

            const paymentData = {
                bookingId: booking._id,
                lotId: booking.lotId,
                lotName: booking.lotName,
                user_email: booking.user_email,
                partnerEmail: partner.email,
                totalPrice,
                partnerEarning: totalPrice * 0.90,
                adminCommission: totalPrice * 0.10,
                currency: "bdt",
                paymentStatus: "pending",
                transactionId: null,
                createdAt: new Date()
            };

            const result = await paymentsCollection.insertOne(paymentData);

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: "bdt",
                            unit_amount: Math.round(totalPrice * 100),
                            product_data: {
                                name: booking.lotName
                            }
                        },
                        quantity: 1
                    }
                ],
                customer_email: booking.user_email,
                mode: "payment",
                metadata: {
                    paymentId: result.insertedId.toString(),
                    bookingId: booking._id.toString(),
                    user_email: booking.user_email
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            });

            await paymentsCollection.updateOne(
                { _id: result.insertedId },
                { $set: { stripeSessionId: session.id } }
            );

            res.send({
                success: true,
                url: session.url,
                paymentId: result.insertedId,
                totalMinutes,
                totalPrice
            });
        });

        // Update payment after successful Stripe Checkout

        app.patch("/payment-success", verifyFBToken, async (req, res) => {
            const sessionId = req.query.session_id;

            if (!sessionId) {
                return res.status(400).send({
                    success: false,
                    message: "Session ID is required",
                });
            }

            const session = await stripe.checkout.sessions.retrieve(sessionId);

            if (session.payment_status !== "paid") {
                return res.send({
                    success: false,
                    message: "Payment not completed",
                });
            }

            const paymentId = session.metadata.paymentId;
            const bookingId = session.metadata.bookingId;

            if (!ObjectId.isValid(paymentId) || !ObjectId.isValid(bookingId)) {
                return res.status(400).send({
                    success: false,
                    message: "Invalid payment or booking ID",
                });
            }

            const payment = await paymentsCollection.findOne({
                _id: new ObjectId(paymentId),
            });

            if (!payment) {
                return res.status(404).send({
                    success: false,
                    message: "Payment not found",
                });
            }

            if (payment.user_email !== req.decodedEmail) {
                return res.status(403).send({ message: "forbidden access" });
            }
            // Verify this Stripe session belongs to this payment
            if (
                payment.bookingId.toString() !== bookingId ||
                payment.stripeSessionId !== session.id
            ) {
                return res.status(400).send({
                    success: false,
                    message: "Payment verification failed",
                });
            }

            const paidAt = payment.paidAt || new Date();

            const paymentInfo = {
                transactionId: session.payment_intent,
                paymentStatus: "paid",
                amount: session.amount_total / 100,
                currency: session.currency,
                customerEmail: session.customer_email,
                paidAt,
            };


            if (payment.paymentStatus === "paid") {

                await bookingsCollection.updateOne(
                    { _id: new ObjectId(bookingId) },
                    {
                        $set: {
                            status: "payment verifying",
                            paymentStatus: "paid",
                            transactionId: paymentInfo.transactionId,
                            amount: paymentInfo.amount,
                            paidAt,
                        },
                    }
                );

                return res.send({
                    success: true,
                    message: "Payment already completed",
                    paymentInfo: payment,
                });
            }

            if (payment.paymentStatus !== "pending") {
                return res.status(400).send({
                    success: false,
                    message: "Payment is not pending",
                });
            }

            const booking = await bookingsCollection.findOne({
                _id: new ObjectId(bookingId),
                status: "payment pending",
            });

            if (!booking) {
                return res.status(400).send({
                    success: false,
                    message: "Booking is not ready for payment completion",
                });
            }

            // Update payment record
            const paymentResult = await paymentsCollection.updateOne(
                {
                    _id: new ObjectId(paymentId),
                    paymentStatus: "pending",
                },
                {
                    $set: paymentInfo,
                }
            );

            if (paymentResult.modifiedCount === 0) {
                return res.status(409).send({
                    success: false,
                    message: "Payment record was already updated",
                });
            }

            // Update booking record for the admin dashboard
            const bookingResult = await bookingsCollection.updateOne(
                {
                    _id: new ObjectId(bookingId),
                    status: "payment pending",
                },

                {
                    $set: {
                        status: "payment verifying",
                        paymentStatus: "paid",
                        transactionId: paymentInfo.transactionId,
                        amount: paymentInfo.amount,
                        paidAt,
                    },
                }
            );

            if (bookingResult.modifiedCount === 0) {
                return res.status(409).send({
                    success: false,
                    message: "Payment saved, but booking update needs verification",
                });
            }

            const updatedPayment = await paymentsCollection.findOne({
                _id: new ObjectId(paymentId),
            });

            res.send({
                success: true,
                message: "Payment successful",
                paymentInfo: updatedPayment,
            });
        });



        //PARTNER
        //update as complete session
        app.patch('/complete-session/:id', verifyFBToken, verifyPartner, async (req, res) => {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: "Invalid booking ID" });
            }

            const email = req.decodedEmail;

            const result = await bookingsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    paymentStatus: "paid",
                    status: "payment verifying",
                    ...(await ownerFilter(email)),
                },
                {
                    $set: {
                        status: "complete session",
                        completesessionAt: new Date(),
                    },
                }
            );

            res.send({ success: result.modifiedCount > 0 });
        });
        //USER
        //get all My Booking History
        app.get('/My-Booking-History', verifyFBToken, async (req, res) => {
            const email = req.decodedEmail;
            const result = await bookingsCollection.find({ user_email: email, status: 'complete session' }).sort({ createdAt: -1 }).toArray();
            res.send(result);
        });
        ///ADMIN
        //get all users Booking History
        app.get('/All-Booking-History', verifyFBToken, verifyAdmin, async (req, res) => {
            const result = await bookingsCollection.find({ status: 'complete session' }).sort({ createdAt: -1 }).toArray();
            res.send(result);
        });



        // Home statistics
        // Home statistics
        app.get("/stats", async (req, res) => {
            const totalActiveUsers = await usersCollection.countDocuments({
                role: "user"
            });

            const totalTrustedPartners = await partnersCollection.countDocuments({
                status: { $ne: "rejected" },
                lotStatus: { $ne: "disabled" }
            });

            res.send({
                totalActiveUsers,
                totalTrustedPartners
            });
        });

        //earnings admin
        app.get("/admin-earnings", verifyFBToken, verifyAdmin, async (req, res) => {
            const result = await paymentsCollection.aggregate([
                {
                    $match: { paymentStatus: "paid" }
                },
                {
                    $group: {
                        _id: null,
                        totalEarnings: { $sum: "$adminCommission" },
                        totalPayments: { $sum: 1 }
                    }
                }
            ]).toArray();

            res.send(result[0] || {
                totalEarnings: 0,
                totalPayments: 0
            });
        });
        //admin stat 7 days
        // Admin: new users & partners
        app.get("/admin-user-growth", verifyFBToken, verifyAdmin, async (req, res) => {
            const TZ = "Asia/Dhaka";
            const DAY = 24 * 60 * 60 * 1000;

            const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
            const todayStart = new Date(`${todayStr}T00:00:00+06:00`);
            const startDate = new Date(todayStart.getTime() - 13 * DAY);

            const daily = await usersCollection.aggregate([
                {
                    $match: {
                        role: { $in: ["user", "partner"] },
                        createdAt: { $gte: startDate }
                    }
                },
                {
                    $group: {
                        _id: {
                            date: {
                                $dateToString: {
                                    format: "%Y-%m-%d",
                                    date: "$createdAt",
                                    timezone: TZ
                                }
                            },
                            role: "$role"
                        },
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        date: "$_id.date",
                        role: "$_id.role",
                        count: 1
                    }
                },
                { $sort: { date: 1 } }
            ]).toArray();

            const totalUsers = await usersCollection.countDocuments({ role: "user" });
            const totalPartners = await usersCollection.countDocuments({ role: "partner" });

            res.send({ daily, totalUsers, totalPartners });
        });

        // Partner earnings
        app.get("/partner-earnings/:email", verifyFBToken,
            verifyPartner, async (req, res) => {
                const result = await paymentsCollection.aggregate([
                    {
                        $match: {
                            partnerEmail: req.params.email,
                            paymentStatus: "paid"
                        }
                    },
                    {
                        $group: {
                            _id: null,

                            // Total revenue
                            totalEarnings: {
                                $sum: "$partnerEarning"
                            },

                            // This month's earnings
                            monthlyEarnings: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                {
                                                    $eq: [
                                                        { $month: "$createdAt" },
                                                        new Date().getMonth() + 1
                                                    ]
                                                },
                                                {
                                                    $eq: [
                                                        { $year: "$createdAt" },
                                                        new Date().getFullYear()
                                                    ]
                                                }
                                            ]
                                        },
                                        "$partnerEarning",
                                        0
                                    ]
                                }
                            },

                            // Today's earnings
                            todayEarnings: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                {
                                                    $dateToString: {
                                                        format: "%Y-%m-%d",
                                                        date: "$createdAt",
                                                        timezone: "Asia/Dhaka"
                                                    }
                                                },
                                                new Date().toLocaleDateString("en-CA", {
                                                    timeZone: "Asia/Dhaka"
                                                })
                                            ]
                                        },
                                        "$partnerEarning",
                                        0
                                    ]
                                }
                            },

                            totalPayments: { $sum: 1 }
                        }
                    }
                ]).toArray();

                res.send({
                    totalEarnings: result[0]?.totalEarnings || 0,
                    monthlyEarnings: result[0]?.monthlyEarnings || 0,
                    todayEarnings: result[0]?.todayEarnings || 0,
                    totalPayments: result[0]?.totalPayments || 0
                });
            });


        // Partner last 7 days bookings stat
        app.get("/admin-user-growth", verifyFBToken,
            verifyPartner, async (req, res) => {
                const TZ = "Asia/Dhaka";
                const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
                const startDate = new Date(
                    new Date(`${todayStr}T00:00:00+06:00`).getTime() - 6 * 24 * 60 * 60 * 1000
                );

                const daily = await usersCollection.aggregate([
                    {
                        $match: {
                            role: { $in: ["user", "partner"] },
                            createdAt: { $gte: startDate }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                date: {
                                    $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ }
                                },
                                role: "$role"
                            },
                            count: { $sum: 1 }
                        }
                    },
                    {
                        $project: { _id: 0, date: "$_id.date", role: "$_id.role", count: 1 }
                    }
                ]).toArray();

                const totalUsers = await usersCollection.countDocuments({ role: "user" });
                const totalPartners = await usersCollection.countDocuments({ role: "partner" });

                res.send({ daily, totalUsers, totalPartners });
            });

        // Partner disable request
        app.patch("/application/disable-request/:id", verifyFBToken,
            verifyPartner, async (req, res) => {
                const { id } = req.params;
                const { email } = req.decodedEmail;
                const result = await partnersCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        email,
                        status: "approved",
                        lotStatus: { $ne: "disabled" },
                    },
                    {
                        $set: {
                            disableRequest: "pending",
                            disableRequestedAt: new Date(),
                        },
                    }
                );

                if (!result.modifiedCount) {
                    return res.status(400).send({
                        message: "Unable to submit disable request.",
                    });
                }

                res.send({
                    success: true,
                    message: "Disable request submitted successfully.",
                });
            });
        //

        app.get("/admin/disable-requests", verifyFBToken,
            verifyAdmin, async (req, res) => {
                const result = await partnersCollection.find({
                    status: "approved",
                    disableRequest: "pending",
                }).toArray();

                res.send(result);
            });


        app.patch("/admin/disable-request/:id", verifyFBToken,
            verifyAdmin, async (req, res) => {
                const { id } = req.params;
                const { action } = req.body;

                if (!["approve", "reject"].includes(action)) {
                    return res.status(400).send({
                        message: "Invalid action",
                    });
                }

                const partner = await partnersCollection.findOne({
                    _id: new ObjectId(id),
                    status: "approved",
                    disableRequest: "pending",
                    lotStatus: { $ne: "disabled" },
                });

                if (!partner) {
                    return res.status(404).send({
                        message: "Disable request not found",
                    });
                }

                // Reject request
                if (action === "reject") {
                    const result = await partnersCollection.updateOne(
                        {
                            _id: new ObjectId(id),
                            disableRequest: "pending",
                        },
                        {
                            $set: {
                                disableRequest: "rejected",
                                disableReviewedAt: new Date(),
                            },
                        }
                    );

                    return res.send({
                        success: result.modifiedCount > 0,
                        message: "Disable request rejected",
                    });
                }

                // Check active bookings
                const activeBooking = await bookingsCollection.findOne({
                    lotId: id,
                    status: {
                        $in: [
                            "waiting for check-in",
                            "check-in requested",
                            "check-in confirm",
                            "check-out requested",
                            "payment pending",
                            "payment verifying",
                        ],
                    },
                });

                if (activeBooking) {
                    return res.status(400).send({
                        message: "This lot has active bookings. Cannot disable it right now.",
                    });
                }

                // Approve disable request
                const result = await partnersCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        disableRequest: "pending",
                        lotStatus: { $ne: "disabled" },
                    },
                    {
                        $set: {
                            lotStatus: "disabled",
                            disableRequest: "approved",
                            disableReviewedAt: new Date(),
                            disabledAt: new Date(),
                        },
                    }
                );

                if (!result.modifiedCount) {
                    return res.status(400).send({
                        message: "Failed to update lot",
                    });
                }

                res.send({
                    success: true,
                    message: "Lot disabled successfully",
                });
            });



















    } catch (error) {
        console.error("MongoDB connection failed:", error);
    }
}

// // Routes
// app.get("/", (req, res) => {
//     res.send("running park");
// });

// // Start server
// async function startServer() {
//     await connectToMongoDB();

//     app.listen(port, () => {
//         console.log(`Server running on port ${port}`);
//     });
// }

// startServer();

// Routes
app.get("/", (req, res) => res.send("running park"));

// Connect to Mongo once, before handling requests
let ready;
function init() {
    if (!ready) ready = connectToMongoDB();
    return ready;
}
app.use(async (req, res, next) => {
    await init();
    next();
});

if (process.env.VERCEL) {
    module.exports = app;          // Vercel
} else {
    init().then(() => app.listen(port, () => console.log(`Server running on port ${port}`)));
}

