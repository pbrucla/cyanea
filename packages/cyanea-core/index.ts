import { Stream } from "node:stream"

import CyaneaEvent from "./event/index.ts"

/**
 * An abstract file store to write static files
 * generated by a CyaneaSink.
 *
 * Filestores begin empty every time Cyanea is run;
 * sinks that output static files should regenerate
 * their outputs every time Cyanea is run regardless
 * of any currently existing outputs.
 */
export interface CyaneaFilestore {
  /**
   * Stages a new file for writing to this filestore.
   * @param file Path of the file to write.
   * @param data File contents to write.
   * @throws If the file path is invalid, or if a file with the given path already exists.
   */
  writeFile(file: string, data: string | ArrayBufferView | Stream): Promise<void>

  /**
   * Commits all staged files to the target medium.
   */
  commit(): Promise<void>
}

/**
 * A target for writing and syncing Cyanea events to.
 *
 * Sinks may choose to sync either the full history
 * of events, or only a time-relative subset of events.
 * Events may be synced by wiping the existing state and
 * recreating all events, or by updating only the difference
 * from the last sync.
 */
export interface CyaneaSink {
  syncEvents(events: CyaneaEvent[], filestore: CyaneaFilestore, now: Date): Promise<void>
}

/**
 * A "source of truth" for a full history of Cyanea events.
 */
export interface CyaneaSource {
  readEvents(): Promise<CyaneaEvent[]>
}

type CyaneaPluginDecl<Type extends "sink" | "source", IsFilestore extends boolean> = {
  type: Type
  load(): Promise<
    (Type extends "sink" ? CyaneaSink : CyaneaSource) & (IsFilestore extends true ? CyaneaFilestore : unknown)
  >
} & (IsFilestore extends true ? { isFilestore: true } : { isFilestore?: false })

/**
 * Base interface for all Cyanea plugins.
 *
 * Each plugin should expose exactly one source
 * or one sink. The source/sink can also be a
 * filestore.
 */
export type CyaneaPlugin =
  | CyaneaPluginDecl<"sink", false>
  | CyaneaPluginDecl<"source", false>
  | CyaneaPluginDecl<"sink", true>
  | CyaneaPluginDecl<"source", true>
