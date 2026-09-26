import pino from "pino"
import { env } from "../env"

export const log = pino({ level: env.LOG_LEVEL })
