import { default as dotenv } from "dotenv";
import { default as mongodb } from "mongodb";

dotenv.config();

const mongodbUrl = 'mongodb://'+process.env.MONGO_USER+':'+process.env.MONGO_PASSWORD+'@'+process.env.MONGO_HOST+':'+process.env.MONGO_PORT;
console.log("Connecting to MongoDB...");
console.log('mongodb://'+process.env.MONGO_USER+':*****@'+process.env.MONGO_HOST+':'+process.env.MONGO_PORT);
const mongoClient = new mongodb.MongoClient(mongodbUrl);
let db = null;
try {
    await mongoClient.connect();
    db = mongoClient.db(process.env.MONGO_DATABASE);
    console.log("Successfully connected to MongoDB");
} catch(error) {
    console.log("Error connecting to MongoDB: "+error);
    throw new Error(error);
}