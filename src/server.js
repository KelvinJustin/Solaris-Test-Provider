
const express = require("express");
const {
    randomUUID,
    createHmac,
    timingSafeEqual,
} = require("node:crypto");
require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT) || 8080;
const CALLBACK_URL = process.env.SOLARIS_CALLBACK_URL;
const CALLBACK_DELAY_MS = Number(process.env.CALLBACK_DELAY_MS) || 2000;
const MAX_CALLBACK_ATTEMPTS = Number(process.env.MAX_CALLBACK_ATTEMPTS) || 3;
const CALLBACK_MODE = process.env.CALLBACK_MODE || "normal";
const SIMULATE_LATENCY = process.env.SIMULATE_LATENCY === "true";
const SIGNING_SECRET = process.env.SIGNING_SECRET;
const DEV_API_KEY = process.env.DEV_API_KEY;
const CALLBACK_TIMEOUT_MS = Number(process.env.CALLBACK_TIMEOUT_MS) || 5000;

if (process.env.NODE_ENV === "production") {
    if (!SIGNING_SECRET || SIGNING_SECRET.length < 32) {
        throw new Error("Production requires a SIGNING_SECRET of at least 32 characters.");
    }
    if (!DEV_API_KEY || DEV_API_KEY.length < 32) {
        throw new Error("Production requires a DEV_API_KEY of at least 32 characters.");
    }
}

if (!["normal", "none", "duplicate"].includes(CALLBACK_MODE)) {
    throw new Error("CALLBACK_MODE must be normal, none, or duplicate.");
}

if (!Number.isInteger(MAX_CALLBACK_ATTEMPTS) || MAX_CALLBACK_ATTEMPTS < 1) {
    throw new Error("MAX_CALLBACK_ATTEMPTS must be a positive integer.");
}

// Capture the exact request bytes so signatures can be verified consistently.
app.use(express.json({
    limit: "32kb",
    verify: (req, _res, buffer) => {
        req.rawBody = buffer.toString("utf8");
    },
}));

// This is a test simulator, not durable storage.
// Restarting the process clears all transactions and logs.
const transactions = new Map();
const transactionReferences = new Set();
const callbackLog = [];

const SCENARIOS = {
    AIRTEL_MONEY: {
        "990000000": { outcome: "SUCCESSFUL" },
        "990000001": { outcome: "FAILED", failureCode: "INSUFFICIENT_FUNDS" },
        "990000002": { outcome: "SUCCESSFUL", silent: true },
        "990000003": { outcome: "SUCCESSFUL", delayMultiplier: 5 },
        "990000004": { outcome: "SUCCESSFUL", duplicates: 3 },
        "990000005": { outcome: "FAILED", failureCode: "PROVIDER_TIMEOUT" },
        "990000006": { outcome: "SUCCESSFUL", contradictoryCallback: true },
        "990000007": { outcome: "SUCCESSFUL", malformedCallback: true },
        "990000008": { outcome: "SUCCESSFUL", simulate503Once: true },
        "990000009": { outcome: "SUCCESSFUL", responseDelayMs: 15000 },
        "990000010": { outcome: "SUCCESSFUL", verificationErrors: 2 },
    },
    TN_MPAMBA: {
        "899817565": { outcome: "SUCCESSFUL" },
        "899817566": { outcome: "FAILED", failureCode: "INVALID_ACCOUNT" },
        "899817567": { outcome: "SUCCESSFUL", silent: true },
        "899817568": { outcome: "SUCCESSFUL", delayMultiplier: 5 },
        "899817569": { outcome: "SUCCESSFUL", duplicates: 3 },
        "899817570": { outcome: "FAILED", failureCode: "DAILY_LIMIT_EXCEEDED" },
        "899817571": { outcome: "SUCCESSFUL", contradictoryCallback: true },
        "899817572": { outcome: "SUCCESSFUL", malformedCallback: true },
        "899817573": { outcome: "SUCCESSFUL", simulate503Once: true },
        "899817574": { outcome: "SUCCESSFUL", responseDelayMs: 15000 },
        "899817575": { outcome: "SUCCESSFUL", verificationErrors: 2 },
    },
};

const VALID_PROVIDERS = Object.keys(SCENARIOS);

const FAILURE_MESSAGES = {
    INSUFFICIENT_FUNDS: "Customer has insufficient funds.",
    PROVIDER_TIMEOUT: "Provider reported a timeout.",
    INVALID_ACCOUNT: "The account is invalid or inactive.",
    DAILY_LIMIT_EXCEEDED: "The transaction limit was exceeded.",
    UNKNOWN_NUMBER: "Unknown simulator test number.",
};

function normalizePhone(phone) {
    return String(phone).replace(/\D/g, "").replace(/^0/, "");
}

function getScenario(provider, phone) {
    return SCENARIOS[provider]?.[normalizePhone(phone)] ?? {
        outcome: "FAILED",
        failureCode: "UNKNOWN_NUMBER",
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(timestamp, rawBody) {
    return createHmac("sha256", SIGNING_SECRET || "local-development-secret")
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
}

function buildPayload(transaction, status = transaction.status) {
    const payload = {
        event: "payment.updated",
        providerReference: transaction.providerReference,
        transactionReference: transaction.transactionReference,
        amount: transaction.amount,
        currency: transaction.currency,
        provider: transaction.provider,
        status,
        occurredAt: new Date().toISOString(),
    };

    if (status === "FAILED") {
        payload.failureCode =
            status === transaction.status
                ? transaction.failureCode
                : "TRANSIENT_ERROR";
        payload.failureMessage =
            FAILURE_MESSAGES[payload.failureCode] || "Payment failed.";
    }

    return payload;
}

function buildMalformedPayload(transaction) {
    return {
        event: "payment.updated",
        providerReference: transaction.providerReference,
        status: null,
        amount: "not-a-number",
        occurredAt: "not-a-date",
    };
}

async function deliverCallback(payload, { simulate503 = false } = {}) {
    const timestamp = Date.now().toString();
    const rawBody = JSON.stringify(payload);

    const record = {
        providerReference: payload.providerReference,
        payload,
        sentAt: new Date().toISOString(),
        httpStatus: null,
        success: false,
        error: null,
    };

    // Simulate a transient network/provider delivery failure.
    // The next attempt performs an actual HTTP request.
    if (simulate503) {
        record.httpStatus = 503;
        record.error = "Injected temporary HTTP 503 failure.";
        callbackLog.push(record);
        return record;
    }

    if (!CALLBACK_URL) {
        record.error = "SOLARIS_CALLBACK_URL is not configured.";
        callbackLog.push(record);
        return record;
    }

    try {
        const response = await fetch(CALLBACK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Provider-Timestamp": timestamp,
                "X-Provider-Signature": signPayload(timestamp, rawBody),
            },
            body: rawBody,
            signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        });

        record.httpStatus = response.status;
        record.success = response.status >= 200 && response.status < 300;
    } catch (error) {
        record.error = error.message;
    }

    callbackLog.push(record);
    return record;
}

async function deliverWithRetry(payload, options = {}) {
    for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt++) {
        const result = await deliverCallback(payload, {
            simulate503: options.simulate503Once && attempt === 1,
        });

        if (result.success) return result;

        if (attempt < MAX_CALLBACK_ATTEMPTS) {
            const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
            await wait(backoffMs);
        }
    }

    return { success: false };
}

async function sendCallbacks(transaction, scenario) {
    // The payment result has already been committed to simulator state.
    // These options affect only whether/how callbacks are delivered.
    if (scenario.silent || CALLBACK_MODE === "none" || !CALLBACK_URL) {
        return;
    }

    const duplicateCount =
        CALLBACK_MODE === "duplicate"
            ? Math.max(2, scenario.duplicates || 2)
            : scenario.duplicates || 1;

    if (scenario.contradictoryCallback) {
        // Intentionally contradictory notification for defensive testing.
        // The verification endpoint remains authoritative.
        await deliverWithRetry(buildPayload(transaction, "FAILED"));
    }

    const payload = scenario.malformedCallback
        ? buildMalformedPayload(transaction)
        : buildPayload(transaction);

    for (let i = 0; i < duplicateCount; i++) {
        await deliverWithRetry(payload, {
            simulate503Once: scenario.simulate503Once && i === 0,
        });

        if (i < duplicateCount - 1) await wait(200);
    }
}

function publicTransaction(transaction) {
    const {
        scenario,
        verificationErrorsRemaining,
        ...publicData
    } = transaction;

    return publicData;
}

// Development routes are protected with a shared secret.
// Do not expose diagnostic or reset controls without authentication.
function requireDevKey(req, res, next) {
    if (!DEV_API_KEY) {
        return res.status(503).json({ error: "Development controls are disabled." });
    }

    const supplied = req.get("X-Dev-Key") || "";
    const expected = Buffer.from(DEV_API_KEY);
    const actual = Buffer.from(supplied);

    if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
    ) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    next();
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        callbackConfigured: Boolean(CALLBACK_URL),
        callbackMode: CALLBACK_MODE,
        maxCallbackAttempts: MAX_CALLBACK_ATTEMPTS,
    });
});

app.post("/initiate", async (req, res) => {
    const {
        transactionReference,
        amount,
        phoneNumber,
        provider,
        currency = "MWK",
    } = req.body;

    const errors = [];

    if (
        typeof transactionReference !== "string" ||
        !transactionReference.trim()
    ) {
        errors.push("transactionReference is required.");
    }

    if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8
    ) {
        errors.push("amount must be positive and have at most two decimal places.");
    }

    if (typeof phoneNumber !== "string" || !phoneNumber.trim()) {
        errors.push("phoneNumber is required.");
    }

    if (!VALID_PROVIDERS.includes(provider)) {
        errors.push(`provider must be one of: ${VALID_PROVIDERS.join(", ")}.`);
    }

    if (currency !== "MWK") {
        errors.push("currency must be MWK.");
    }

    if (
        typeof transactionReference === "string" &&
        transactionReferences.has(transactionReference)
    ) {
        errors.push("transactionReference has already been used.");
    }

    if (errors.length) return res.status(400).json({ errors });

    const scenario = getScenario(provider, phoneNumber);
    const providerReference = randomUUID();

    const transaction = {
        providerReference,
        transactionReference,
        amount,
        currency,
        phoneNumber,
        provider,
        status: "PROCESSING",
        failureCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        verificationErrorsRemaining: scenario.verificationErrors || 0,
        scenario,
    };

    transactions.set(providerReference, transaction);
    transactionReferences.add(transactionReference);

    // Completion and callback delivery are separate.
    // Even when no callback is sent, verification can return the final result.
    const completionDelay =
        CALLBACK_DELAY_MS * (scenario.delayMultiplier || 1);

    setTimeout(async () => {
        transaction.status = scenario.outcome;
        transaction.failureCode = scenario.failureCode || null;
        transaction.updatedAt = new Date().toISOString();

        if (SIMULATE_LATENCY) await wait(Math.random() * 1000);

        await sendCallbacks(transaction, scenario);
    }, completionDelay);

    const responseBody = {
        providerReference,
        transactionReference,
        status: "PROCESSING",
        message: "Payment accepted for simulation.",
    };

    // The client can time out while the simulated payment continues processing.
    // This tests ambiguous initiation results and subsequent verification.
    if (scenario.responseDelayMs) await wait(scenario.responseDelayMs);

    return res.status(202).json(responseBody);
});

app.get("/transactions/:providerReference", (req, res) => {
    const transaction = transactions.get(req.params.providerReference);

    if (!transaction) {
        return res.status(404).json({ error: "Transaction not found." });
    }

    if (transaction.verificationErrorsRemaining > 0) {
        transaction.verificationErrorsRemaining--;
        return res.status(503).json({
            error: "Simulated temporary verification failure.",
        });
    }

    return res.json(publicTransaction(transaction));
});

// ---------------------------------------------------------------------------
// PROTECTED DEVELOPMENT CONTROLS
// ---------------------------------------------------------------------------

app.use("/dev", requireDevKey);

app.get("/dev/scenarios", (_req, res) => {
    res.json(SCENARIOS);
});

app.get("/dev/transactions", (_req, res) => {
    res.json([...transactions.values()].map(publicTransaction));
});

app.get("/dev/callbacks", (_req, res) => {
    res.json(callbackLog);
});

app.post("/dev/callback/fire", async (req, res) => {
    const { providerReference, status } = req.body;

    if (!["SUCCESSFUL", "FAILED"].includes(status)) {
        return res.status(400).json({
            error: "status must be SUCCESSFUL or FAILED.",
        });
    }

    const transaction = transactions.get(providerReference);

    if (!transaction) {
        return res.status(404).json({ error: "Transaction not found." });
    }

    // This intentionally changes the authoritative simulated outcome.
    transaction.status = status;
    transaction.failureCode = status === "FAILED" ? "PROVIDER_TIMEOUT" : null;
    transaction.updatedAt = new Date().toISOString();

    const result = await deliverWithRetry(buildPayload(transaction));

    return res.json({
        delivered: Boolean(result.success),
        providerReference,
        status,
    });
});

app.post("/dev/reset", (_req, res) => {
    transactions.clear();
    transactionReferences.clear();
    callbackLog.length = 0;

    return res.json({ ok: true, message: "Simulator state cleared." });
});

// The verification endpoint returns authoritative payment state,
// including when callback delivery is disabled or fails.
// Start the server with a polished terminal startup animation.
async function startServer() {
    const chalk = (await import("chalk")).default;
    const ora = (await import("ora")).default;

    const spinner = ora({
        text: chalk.gray("Initializing payment simulator..."),
        spinner: "dots",
        color: "cyan",
    }).start();

    // Brief animation before announcing that the server is ready.
    await new Promise((resolve) => setTimeout(resolve, 800));

    app.listen(PORT, "0.0.0.0", () => {
        spinner.succeed(chalk.green("Payment simulator started successfully!"));

        console.log();
        console.log(chalk.cyan.bold("  ┌──────────────────────────────────────┐"));
        console.log(chalk.cyan.bold("  │       SOLARIS PAYMENT SIMULATOR      │"));
        console.log(chalk.cyan.bold("  └──────────────────────────────────────┘"));
        console.log();

        console.log(
            `  ${chalk.green("●")} ${chalk.bold("Status")}        ${chalk.green("ONLINE")}`,
        );

        console.log(
            `  ${chalk.blue("➜")} ${chalk.bold("Port")}          ${chalk.white(PORT)}`,
        );

        console.log(
            `  ${chalk.blue("➜")} ${chalk.bold("Health")}        ${chalk.underline(`http://localhost:${PORT}/health`)}`,
        );

        console.log(
            `  ${chalk.blue("➜")} ${chalk.bold("Callback URL")}  ${chalk.gray(CALLBACK_URL || "Not configured")}`,
        );

        console.log(
            `  ${chalk.blue("➜")} ${chalk.bold("Callback mode")} ${chalk.magenta(CALLBACK_MODE)}`,
        );

        console.log();
        console.log(chalk.gray("  Waiting for payment requests..."));
        console.log();
    });
}

startServer().catch((error) => {
    console.error(`Failed to start simulator: ${error.message}`);
    process.exit(1);
});