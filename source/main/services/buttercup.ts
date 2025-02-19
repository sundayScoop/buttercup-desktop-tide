import { BrowserWindow } from "electron";
import {
    AttachmentDetails,
    AttachmentManager,
    consumeVaultFacade,
    createVaultFacade,
    Credentials,
    Entry,
    EntryID,
    EntryType,
    GroupID,
    TextDatasource,
    Vault,
    VaultFacade,
    VaultFormatID,
    VaultManager,
    VaultSource,
    VaultSourceID,
    VaultSourceStatus,
    init
} from "buttercup-heimdall";
import { exportVaultToCSV } from "@buttercup/exporter";
import { describeSource } from "../library/sources";
import { clearFacadeCache } from "./facades";
import { notifyWindowsOfSourceUpdate } from "./windows";
import { getVaultCacheStorage, getVaultStorage } from "./storage";
import { updateSearchCaches } from "./search";
import { setAutoLockEnabled } from "./autoLock";
import { logErr, logInfo } from "../library/log";
import { attachSourceEncryptedListeners } from "./backup";
import { extractVaultOTPItems } from "../library/otp";
import { OTP, SourceType, VaultSourceDescription } from "../types";
import { validateToken, tideJWT } from "../services/tokenValidation";
import { ipcMain } from "electron";
import { openAuthenticationWindow } from "..";

const __watchedVaultSources: Array<VaultSourceID> = [];
let __vaultManager: VaultManager;

export async function addAttachment(
    sourceID: VaultSourceID,
    entryID: EntryID,
    filename: string,
    type: string,
    data: Buffer
) {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const entry = source.vault.findEntryByID(entryID);
    await source.attachmentManager.setAttachment(
        entry,
        AttachmentManager.newAttachmentID(),
        data,
        filename,
        type
    );
}

export async function addVault(
    name: string,
    sourceCredentials: Credentials,
    passCredentials: Credentials,
    type: SourceType,
    createNew: boolean = false
): Promise<VaultSourceID> {
    console.log("addVault Check1");
    const credsSecure = await sourceCredentials.toSecureString();
    console.log("addVault Check2");
    const vaultManager = getVaultManager();
    console.log("addVault Check3");
    const source = new VaultSource(name, type, credsSecure);
    console.log("addVault Check4");
    await vaultManager.interruptAutoUpdate(async () => {
        console.log("addVault Check5.1");
        await vaultManager.addSource(source);
        console.log("addVault Check5.2");
        await source.unlock(passCredentials, { initialiseRemote: createNew });
        console.log("addVault Check5.3");
        await vaultManager.dehydrateSource(source);
    });
    console.log("addVault Check6");
    return source.id;
}

export async function attachVaultManagerWatchers() {
    const vaultManager = getVaultManager();
    vaultManager.on("autoUpdateFailed", ({ source, error }) => {
        logErr(`Auto update failed for source: ${source.id}`, error);
    });
    vaultManager.on("sourcesUpdated", async () => {
        sendSourcesToWindows();
        vaultManager.unlockedSources.forEach((source) => {
            logErr(`Vault sources to be updated ${source.id}`);
            if (!__watchedVaultSources.includes(source.id)) {
                source.on("updated", () => onVaultSourceUpdated(source));
                __watchedVaultSources.push(source.id);
            }
            attachSourceEncryptedListeners(source);
        });
        await updateSearchCaches(vaultManager.unlockedSources);
    });
}

export async function convertVaultFormatAToB(sourceID: VaultSourceID): Promise<void> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    logInfo(`converting source to format B: ${sourceID}`);
    await source.convert(VaultFormatID.B);
    await source.write();
}

export async function createNewEntry(
    sourceID: VaultSourceID,
    groupID: GroupID,
    type: EntryType,
    properties: Record<string, string>
): Promise<string> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const group = source.vault.findGroupByID(groupID);
    const title = (properties.title || "").trim() || "Untitled";
    const entry = group.createEntry(title);
    entry.setAttribute(Entry.Attributes.FacadeType, type);
    for (const key in properties) {
        entry.setProperty(key, properties[key]);
    }
    await source.save();
    return entry.id;
}

export async function deleteAttachment(
    sourceID: VaultSourceID,
    entryID: EntryID,
    attachmentID: string
) {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const entry = source.vault.findEntryByID(entryID);
    await source.attachmentManager.removeAttachment(entry, attachmentID);
    await source.save();
}

export async function exportVault(sourceID: VaultSourceID): Promise<string> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const exported = await exportVaultToCSV(source.vault);
    return exported;
}

export function getAllOTPs(): Array<OTP> {
    const vaultManager = getVaultManager();
    return vaultManager.unlockedSources.reduce((otps: Array<OTP>, source: VaultSource) => {
        return [...otps, ...extractVaultOTPItems(source)];
    }, [] as Array<OTP>);
}

export async function getAttachmentData(
    sourceID: VaultSourceID,
    entryID: EntryID,
    attachmentID: string
): Promise<Buffer> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const entry = source.vault.findEntryByID(entryID);
    return source.attachmentManager.getAttachment(entry, attachmentID) as Promise<Buffer>;
}

export async function getAttachmentDetails(
    sourceID: VaultSourceID,
    entryID: EntryID,
    attachmentID: string
): Promise<AttachmentDetails> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const entry = source.vault.findEntryByID(entryID);
    return source.attachmentManager.getAttachmentDetails(entry, attachmentID);
}

export function getSourceDescription(sourceID: VaultSourceID): VaultSourceDescription {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    return source ? describeSource(source) : null;
}

export function getSourceDescriptions(): Array<VaultSourceDescription> {
    const vaultManager = getVaultManager();
    return vaultManager.sources.map((source) => describeSource(source));
}

export function getVaultFacadeBySource(sourceID: VaultSourceID): VaultFacade {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    if (!source) {
        throw new Error(`Cannot generate facade: No source found for ID: ${sourceID}`);
    } else if (source.status !== VaultSourceStatus.Unlocked) {
        throw new Error(`Cannot generate facade: Source is not unlocked: ${sourceID}`);
    }
    return createVaultFacade(source.vault);
}

export async function getEmptyVault(password: string): Promise<string> {
    const creds = Credentials.fromPassword(password);
    const vault = Vault.createWithDefaults();
    const tds = new TextDatasource(Credentials.fromPassword(password));
    return tds.save(vault.format.getHistory(), creds);
}

export function getSourceAttachmentsSupport(sourceID: VaultSourceID): boolean {
    const mgr = getVaultManager();
    const source = mgr.getSourceForID(sourceID);
    return source.supportsAttachments();
}

export function getSourceStatus(sourceID: VaultSourceID): VaultSourceStatus | null {
    const mgr = getVaultManager();
    const source = mgr.getSourceForID(sourceID);
    return (source && source.status) || null;
}

export function getUnlockedSourceIDs(): Array<VaultSourceID> {
    const mgr = getVaultManager();
    return mgr.unlockedSources.map((src) => src.id);
}

export function getUnlockedSourcesCount(): number {
    const mgr = getVaultManager();
    return mgr.unlockedSources.length;
}

export function getVaultFormat(sourceID: VaultSourceID): VaultFormatID {
    const mgr = getVaultManager();
    const source = mgr.getSourceForID(sourceID);
    if (source.status !== VaultSourceStatus.Unlocked) return null;
    return source.vault.format.getFormat().getFormatID();
}

export function getVaultType(sourceID: VaultSourceID): string {
    const mgr = getVaultManager();
    const source = mgr.getSourceForID(sourceID);
    return source.type;
}

function getVaultManager(): VaultManager {
    if (!__vaultManager) {
        init();
        __vaultManager = new VaultManager({
            cacheStorage: getVaultCacheStorage(),
            sourceStorage: getVaultStorage()
        });
    }
    return __vaultManager;
}

export async function loadVaultsFromDisk() {
    await getVaultManager().rehydrate();
}

export async function lockAllSources() {
    const vaultManager = getVaultManager();
    if (vaultManager.unlockedSources.length === 0) return;
    await Promise.all(vaultManager.unlockedSources.map((source) => source.lock()));
}

export async function lockSource(sourceID: VaultSourceID) {
    logInfo("Inside lock source!");
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    if (source.status === VaultSourceStatus.Unlocked) {
        await source.lock();
    }
}

export async function mergeVaults(targetSourceID: VaultSourceID, incomingVault: Vault) {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(targetSourceID);
    const incomingFacade = createVaultFacade(incomingVault);
    consumeVaultFacade(source.vault, incomingFacade, { mergeMode: true });
    await source.save();
}

export function onSourcesUpdated(callback: () => void): () => void {
    const vaultManager = getVaultManager();
    const innerCB = () => callback();
    vaultManager.on("sourcesUpdated", innerCB);
    return () => vaultManager.off("sourcesUpdated", innerCB);
}

function onVaultSourceUpdated(source: VaultSource) {
    clearFacadeCache(source.id);
    notifyWindowsOfSourceUpdate(source.id);
}

export async function removeSource(sourceID: VaultSourceID) {
    const vaultManager = getVaultManager();
    clearFacadeCache(sourceID);
    await vaultManager.removeSource(sourceID);
}

export async function saveSource(sourceID: VaultSourceID) {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    await source.save();
}

export async function saveVaultFacade(sourceID: VaultSourceID, facade: VaultFacade): Promise<void> {
    logErr(`Facade check 1`);
    const vaultManager = getVaultManager();
    logErr(`Facade check 2`);
    const source = vaultManager.getSourceForID(sourceID);
    logErr(`Facade check 3`);
    consumeVaultFacade(source.vault, facade);
    logErr(`Facade check 4: ${source.id}`);
    await source.save();
}

export function sendSourcesToWindows() {
    const vaultManager = getVaultManager();
    const windows = BrowserWindow.getAllWindows();
    const sourceDescriptions = vaultManager.sources.map((source) => describeSource(source));
    for (const win of windows) {
        win.webContents.send("vaults-list", JSON.stringify(sourceDescriptions));
    }
}

export async function setSourceOrder(sourceID: VaultSourceID, newOrder: number) {
    const vaultManager = getVaultManager();
    await vaultManager.reorderSource(sourceID, newOrder);
    await vaultManager.dehydrate();
}

export async function setSourcesOrder(sourceIDs: Array<VaultSourceID>) {
    const vaultManager = getVaultManager();
    for (let i = 0; i < sourceIDs.length; i += 1) {
        const source = vaultManager.getSourceForID(sourceIDs[i]);
        source.order = i;
    }
    vaultManager.reorderSources();
    await vaultManager.dehydrate();
}

export async function testSourceMasterPassword(
    sourceID: VaultSourceID,
    password: string
): Promise<boolean> {
    const source = getVaultManager().getSourceForID(sourceID);
    return source.testMasterPassword(password);
}

export async function toggleAutoUpdate(autoUpdateEnabled: boolean = true) {
    setAutoLockEnabled(autoUpdateEnabled);
    const vaultManager = getVaultManager();
    await vaultManager.enqueueStateChange(() => {});
    vaultManager.toggleAutoUpdating(autoUpdateEnabled);
}

export async function unlockSource(sourceID: VaultSourceID, password: string | Object) {
    logInfo("Inside unlock source!");
    // TODO this validates jwt? May not be needed?
    // until I can test with the non test encryption functions
    // I don't know if this is needed.
    // this is here to check if the tide session for the source is still valid?
    // CHECK HERE
    if (typeof password !== "string") {
        const isValid = await validateToken(tideJWT);
        logInfo("Is Valid: ", isValid);
        if (!isValid) {
            logInfo("Bad Token");
            await openAuthenticationWindow(null);
        }
    }

    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    await source.unlock(Credentials.fromPassword(password));
}

export async function updateExistingEntry(
    sourceID: VaultSourceID,
    entryID: EntryID,
    properties: Record<string, string>
): Promise<void> {
    const vaultManager = getVaultManager();
    const source = vaultManager.getSourceForID(sourceID);
    const entry = source.vault.findEntryByID(entryID);
    for (const key in properties) {
        entry.setProperty(key, properties[key]);
    }
    await source.save();
}
