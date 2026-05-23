import express from "express";
import { configDotenv } from "dotenv";
import { Pool } from "pg";
import format from "pg-format";
import rateLimit from "express-rate-limit";
import path from "path";
import cors from "cors";

configDotenv();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function initDB() {
    await pool.query(
        `CREATE TABLE IF NOT EXISTS links (id SERIAL PRIMARY KEY, link TEXT NOT NULL UNIQUE, short TEXT NOT NULL UNIQUE)`,
    );
}
await initDB();
export async function addItem(data, relation) {
    let keys = Object.keys(data);
    let values = Object.values(data);
    let query = format(
        "INSERT INTO %I (%I) VALUES (%L) RETURNING id",
        relation,
        keys,
        values,
    );
    let result = await pool.query(query);
    return result;
}

export async function findItem(data, relation, limit = "ALL", common = true) {
    let keys = Object.keys(data);
    let values = Object.values(data);
    if (keys.length === 0)
        return (await pool.query(format("SELECT * FROM %I", relation))).rows;
    if (limit !== "ALL" && isNaN(limit))
        throw new Error("Limit must be a number");
    let conditions = keys
        .map((k, i) => {
            return format("%I = %L", k, values[i]);
        })
        .join(` ${common ? "AND" : "OR"} `);
    let query = format(
        "SELECT * FROM %I WHERE (%s) LIMIT %s",
        relation,
        conditions,
        limit,
    );
    let result = await pool.query(query);
    return result;
}
export async function updateItem(data, filters, relation, common = true) {
    const dataKeys = Object.keys(data);
    const dataValues = Object.values(data);
    const setClause = dataKeys
        .map((k, i) => format("%I = %L", k, dataValues[i]))
        .join(", ");

    const filterKeys = Object.keys(filters);
    const filterValues = Object.values(filters);

    if (filterKeys.length === 0) {
        throw new Error(
            "You must provide at least one filter to update a row safely.",
        );
    }

    const whereClause = filterKeys
        .map((k, i) => format("%I = %L", k, filterValues[i]))
        .join(` ${common ? "AND" : "OR"} `);
    let query = format(
        "UPDATE %I SET %s WHERE %s",
        relation,
        setClause,
        whereClause,
    );
    let result = await pool.query(query);
    return result;
}
const ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;

function encode(num) {
    let n = BigInt(num);
    if (n === 0n) return "0";

    let result = "";

    while (n > 0n) {
        const remainder = n % BASE;
        result = ALPHABET[Number(remainder)] + result;
        n = n / BASE;
    }

    return result;
}

function decode(str) {
    let result = 0n;

    for (let char of str) {
        result = result * BASE + BigInt(ALPHABET.indexOf(char));
    }

    return result.toString();
}

let app = express();

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 15 minutes
    limit: 60, // max 100 requests per IP
    standardHeaders: true,
    legacyHeaders: false,
});
const shortLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 15 minutes
    limit: 10, // max 100 requests per IP
    standardHeaders: true,
    legacyHeaders: false,
});
app.set("trust proxy", 1);
app.use(limiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/assets", express.static(path.resolve("assets")));
app.get("/", (req, res) => {
    return res.sendFile(path.resolve("index.html"));
});
app.get("/favicon.ico", (req, res) => {
    res.sendFile(path.resolve("favicon.ico"));
});
app.post("/short/", shortLimiter, async (req, res) => {
    let link = req.body.link;
    if (!link || !link.includes("."))
        return res.status(400).json({ short: "invalid link" });
    link = link.trim();
    if (!link.startsWith("https://") && !link.startsWith("http://"))
        link = "https://" + link;
    let url;
    try {
        url = new URL(link);
        url.hash = "";
    } catch (e) {
        return res.status(400).json({ short: "invalid link" });
    }
    let baseUrl = process.env.APP_URL;
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    let find = (await findItem({ link: url.toString() }, "links")).rows;
    if (find[0]) return res.json({ short: baseUrl + find[0].short });

    let index = (await addItem({ link: url.toString(), short: "" }, "links"))
        .rows[0];
    let base62 = encode(index.id);
    await updateItem({ short: base62 }, { id: index.id }, "links");
    res.json({ short: baseUrl + base62 });
});
app.get("/:path", async (req, res, next) => {
    let short = req.params.path;
    let find = (await findItem({ short }, "links")).rows;
    if (find.length === 0) return next();
    res.redirect(find[0].link);
});
app.use((req, res) => res.status(404).json({ error: "Doesnt exists" }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError) {
        return res.status(400).json({ error: "invalid json" });
    }
    console.log(err);
    res.status(500).json({ error: "internal server error" });
});
app.listen(process.env.PORT || 5000);
