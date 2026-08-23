import { Socket } from "socket.io";
import { HydratedDocument } from "mongoose";
import { IUser } from "../models/User.js";

declare module "socket.io" {
  interface Socket {
    user?: HydratedDocument<IUser>;
  }
}
