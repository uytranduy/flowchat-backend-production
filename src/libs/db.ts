import mongoose from "mongoose";
import { config } from "../config/index.js";

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(config.MONGODB_CONNECTIONSTRING);
    console.log("Liên kết CSDL thành công!");
  } catch (error) {
    console.log("Lỗi khi kết nối CSDL:", error);
    process.exit(1);
  }
};
