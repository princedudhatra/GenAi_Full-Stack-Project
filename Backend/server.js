const dns = require('node:dns');
const mongoose = require('mongoose');

// Use working DNS servers for MongoDB SRV lookups
dns.setServers(["8.8.8.8", "1.1.1.1"]);

require("dotenv").config();
const app = require("./src/app")

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB connected successfully");

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

startServer();