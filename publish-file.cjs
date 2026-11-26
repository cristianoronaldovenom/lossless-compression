"use strict";

const fs = require("node:fs");
const path = require("node:path");

function flushParentDirectory(destination) {
    // Windows does not expose directory flushing through Node's portable open API.
    if (process.platform === "win32") return;
    let directory;
    try {
        directory = fs.openSync(path.dirname(destination), "r");
        fs.fsyncSync(directory);
    } catch (error) {
        if (!["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) {
            process.emitWarning("Output is published, but its directory could not be flushed: " + error.message);
        }
    } finally {
        if (directory !== undefined) {
            try { fs.closeSync(directory); }
            catch (error) { process.emitWarning("Could not close output directory: " + error.message); }
        }
    }
}

async function publishFile(destination, write) {
    const absolute = path.resolve(destination);
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })) {
        throw Object.assign(Error("Destination already exists: " + absolute), { code: "EEXIST" });
    }
    const tempDirectory = fs.mkdtempSync(path.join(path.dirname(absolute), ".symbol10-"));
    const temporary = path.join(tempDirectory, "output");
    try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
            await write(fd);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.linkSync(temporary, absolute);
        } catch (error) {
            if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EPERM"].includes(error.code)) throw error;
            // The archive has already been fully written and verified before an exclusive copy.
            fs.copyFileSync(temporary, absolute, fs.constants.COPYFILE_EXCL);
            try {
                const copied = fs.openSync(absolute, "r+");
                try { fs.fsyncSync(copied); } finally { fs.closeSync(copied); }
            } catch (cause) {
                throw Error("Output was copied to " + absolute + " but could not be flushed: " + cause.message, { cause });
            }
        }
        flushParentDirectory(absolute);
    } finally {
        try {
            fs.rmSync(temporary, { force: true });
            fs.rmdirSync(tempDirectory);
        } catch (error) {
            process.emitWarning("Could not remove staging directory " + tempDirectory + ": " + error.message);
        }
    }
}

module.exports = { publishFile };
