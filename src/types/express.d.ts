import { HydratedDocument } from "mongoose";
import { IUser } from "../models/User.js";
import { IConversation } from "../models/Conversation.js";

declare global {
  namespace Express {
    interface Request {
      user?: HydratedDocument<IUser>;
      conversation?: HydratedDocument<IConversation>;
    }
  }
}
