import { appCacheDir, appConfigDir, join } from "@tauri-apps/api/path";
import { readBinaryFile, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import {  } from "@tauri-apps/api";
import CryptoJS from "crypto-js";
import { osType } from "./env";
import * as http from "@tauri-apps/plugin-http"

export async function invoke_plugin(pluginType, pluginName) {
    let configDir = await appConfigDir();
    let cacheDir = await appCacheDir();
    let pluginDir = await join(configDir, "plugins", pluginType, pluginName);
    let entryFile = await join(pluginDir, "main.js");
    let script = await readTextFile(entryFile);
    async function run(cmdName, args) {
        return await invoke("run_binary", {
            pluginType,
            pluginName,
            cmdName,
            args
        });
    }
    const utils = {
        tauriFetch: http.fetch,
        http,
        readBinaryFile,
        readTextFile,
        Database,
        CryptoJS,
        run,
        cacheDir, // String
        pluginDir, // String
        osType,// "Windows_NT", "Darwin", "Linux"
    }
    return [eval(`${script} ${pluginType}`), utils];
}