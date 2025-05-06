import { Sticker } from "wa-sticker-formatter";
import { Boom } from "@hapi/boom";
import makeWASocket, { 
    makeInMemoryStore, 
    useMultiFileAuthState,
    DisconnectReason,
    WAMessage,
    MediaType,
    DownloadableMessage,
    downloadContentFromMessage,
    WASocket,
    proto
} from "baileys";
import qrcode from "qrcode";
import pino from "pino";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegStatic);

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState("auth"); // Not recommended. VERY bad for IO.
    const store = makeInMemoryStore({}); // You can add Pino's logging if you need.

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        getMessage: async (key) => (await store.loadMessage(key.remoteJid, key.id))?.message || undefined
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(await qrcode.toString(qr, { type: "terminal" }));
        }

        if (connection === "close" && (lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.restartRequired) {
            await connect();
        } else if (connection === "open") {
            console.log("Connected to WhatsApp");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const validMessages = messages.filter(
            (context) => 
                context.message &&
                !context.key.fromMe &&
                context.key.remoteJid.endsWith("@s.whatsapp.net")
        );

        for (const context of validMessages) {
            try {
                const buffer = await processMessage(context);

                if (!buffer) return;

                await sendReaction(sock, context, "🕐");

                const sticker = new Sticker(buffer, {
                    pack: "🤖 Feito por",
                    author: "@joaomfr"
                });

                await sock.sendMessage(
                    context.key.remoteJid, 
                    await sticker.toMessage(),
                    { quoted: context }
                );

                await sendReaction(sock, context, "✅");

                console.info(`+${context.key.remoteJid.split('@')[0]} has created a new sticker`);
            } catch (error) {
                console.log("Could not create sticker", error);

                await sendReaction(sock, context, "❌");
            }
        }
    });
}

async function processMessage(context: WAMessage) {
    let message, buffer: Buffer, fileType: String;

    if (context.message.imageMessage) {
        message = context.message.imageMessage;
        fileType = "image";
    } else if (context.message.videoMessage) {
        message = context.message.videoMessage;
        fileType = "video";
    }

    if (message) {
        buffer = await downloadBuffer(message, fileType as MediaType);
    }

    return buffer;
}

async function downloadBuffer(message: DownloadableMessage, type: MediaType) {
    let buffer = Buffer.from([]);

    try {
        const stream = await downloadContentFromMessage(message, type);

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return buffer;
    } catch (error) {
        console.log("Error downloading message", error);
        return null;
    }
}

async function sendReaction(sock: WASocket, context: proto.IWebMessageInfo, reaction: string) {
    await sock.sendMessage(
        context.key.remoteJid, 
        { react: { text: reaction, key: context.key } },
        { quoted: context }
    );
}

connect();