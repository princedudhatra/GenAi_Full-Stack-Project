const express = require('express')
const cookieParser = require('cookie-parser')
const cors = require("cors")
const app = express()

//Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin :"http://localhost:5173",
    credentials : true
}))

// require all routes here
const authRouter = require("./routes/auth.routes")
const interviewRouter = require("./routes/interview.routes")

// use all routes here
app.use("/api/auth",authRouter)
app.use("/api/interview",interviewRouter)

module.exports = app