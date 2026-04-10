import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

export interface RemoteJournal {
  operationKey: string;
  createdAt: string;
  updatedAt: string;
  completedOutputs: string[];
  failedInputs: string[];
}

function getJournalDir(): string {
  return path.join(os.homedir(), ".leano", "journals");
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function buildOperationKey(input: string): string {
  const h = crypto.createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

export function getJournalPath(profileName: string, operationKey: string): string {
  const file = `${sanitizeName(profileName)}-${operationKey}.json`;
  return path.join(getJournalDir(), file);
}

export function loadJournal(profileName: string, operationKey: string): RemoteJournal | null {
  const p = getJournalPath(profileName, operationKey);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as RemoteJournal;
  if (!parsed || parsed.operationKey !== operationKey) return null;
  if (!Array.isArray(parsed.completedOutputs) || !Array.isArray(parsed.failedInputs)) return null;
  return parsed;
}

export function createJournal(operationKey: string): RemoteJournal {
  const now = new Date().toISOString();
  return {
    operationKey,
    createdAt: now,
    updatedAt: now,
    completedOutputs: [],
    failedInputs: [],
  };
}

export function saveJournal(profileName: string, journal: RemoteJournal): string {
  const dir = getJournalDir();
  fs.mkdirSync(dir, { recursive: true });
  journal.updatedAt = new Date().toISOString();
  const out = getJournalPath(profileName, journal.operationKey);
  fs.writeFileSync(out, JSON.stringify(journal, null, 2) + "\n", "utf-8");
  return out;
}

export function removeJournal(profileName: string, operationKey: string): void {
  const p = getJournalPath(profileName, operationKey);
  if (!fs.existsSync(p)) return;
  fs.unlinkSync(p);
}
