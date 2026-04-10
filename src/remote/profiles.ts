import fs from "fs";
import os from "os";
import path from "path";

export interface RemoteProfile {
  name: string;
  url: string;
  token?: string;
}

interface RemoteProfileStore {
  profiles: RemoteProfile[];
}

const CONFIG_DIR = path.join(os.homedir(), ".leano");
const CONFIG_PATH = path.join(CONFIG_DIR, "remote-profiles.json");

function readStore(): RemoteProfileStore {
  if (!fs.existsSync(CONFIG_PATH)) return { profiles: [] };
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as RemoteProfileStore;
  if (!parsed || !Array.isArray(parsed.profiles)) return { profiles: [] };
  return parsed;
}

function writeStore(store: RemoteProfileStore): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function saveProfile(profile: RemoteProfile): void {
  const store = readStore();
  const idx = store.profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.push(profile);
  store.profiles.sort((a, b) => a.name.localeCompare(b.name));
  writeStore(store);
}

export function getProfile(name: string): RemoteProfile | null {
  const store = readStore();
  return store.profiles.find((p) => p.name === name) ?? null;
}

export function getProfilesPath(): string {
  return CONFIG_PATH;
}
