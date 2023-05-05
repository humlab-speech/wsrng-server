import fs from "fs";
import { default as dotenv } from "dotenv";
import { default as mongodb } from "mongodb";
import mime from "mime";

dotenv.config();

if (process.argv.length !== 3) {
  console.error('Usage: node base64encode.js filename');
  process.exit(1);
}

const filePath = process.argv[2];

fs.readFile(filePath, async (err, data) => {
  if (err) {
    console.error(`Error reading file: ${err}`);
    process.exit(1);
  }

  const filename = filePath.split('/').pop();

  const mimeType = mime.getType(filePath);
  const base64 = data.toString('base64');
  //console.log(base64);

  const mongodbUrl = 'mongodb://'+process.env.MONGO_USER+':'+process.env.MONGO_PASSWORD+'@localhost:'+process.env.MONGO_PORT;
  console.log("Connecting to MongoDB...");
  const mongoClient = new mongodb.MongoClient(mongodbUrl);
  let db = null;
  try {
      await mongoClient.connect();
      db = mongoClient.db(process.env.MONGO_DATABASE);
      db.collection("resources").insertOne({
        "scriptId": 1245,
        "name": filename,
        "data": base64,
        "mimeType": mimeType,
      });

      console.log("Imported resource into MongoDB");
  } catch(error) {
      console.log("Error connecting to MongoDB: "+error);
      throw new Error(error);
  }

});

