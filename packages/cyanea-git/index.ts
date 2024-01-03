import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { getEnvCredentials, resolvePathOrThrow } from "@pbrucla/cyanea-core/util/index.ts"
import chalk from "chalk"
import git, { GitAuth, TreeEntry } from "isomorphic-git"
import http from "isomorphic-git/http/node"
import openpgp from "openpgp"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// TODO document credentials:
//
// - CYANEA_GIT_COMMIT_KEY
// - CYANEA_GIT_COMMIT_PASSPHRASE
//
// - CYANEA_GIT_REMOTE_USERNAME
// - CYANEA_GIT_REMOTE_PASSWORD

function remoteCredentialsCallback(action: string, creds: GitAuth | null): () => GitAuth | void {
  return () => {
    if (creds) {
      return creds
    } else {
      console.warn(
        chalk.yellow(
          ` warn: Git requested credentials to ${action}, but no credentials were supplied.
       Please set CYANEA_GIT_REMOTE_[USERNAME, PASSWORD] with a valid username/password, Personal Access Token, or OAuth2 token combination.
       See https://isomorphic-git.org/docs/en/onAuth#option-1-username-password for more information.`,
        ),
      )
    }
  }
}

async function cloneRepo(
  remote: string,
  branch: string | undefined,
  tempFolderPrefix: string,
  credentials: GitAuth | null,
): Promise<string> {
  // make sure local file urls don't escape cwd
  if (remote.trim().startsWith("file://")) {
    remote = resolvePathOrThrow(process.cwd(), remote.trim().substring(7))
  } else if (!remote.match(/^([a-z][a-z0-9+\-.]*):\/\/.*?$/)) {
    remote = resolvePathOrThrow(process.cwd(), remote)
  }

  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), `cyanea-git-${tempFolderPrefix}`))
  await git.clone({
    fs,
    http,
    dir: tempPath,
    url: remote,
    ref: branch,
    singleBranch: true,
    onAuth: remoteCredentialsCallback(`clone repository ${remote}`, credentials),
  })
  return tempPath
}

// Check if the working directory of the given repository is clean.
async function isRepoClean(repo: string): Promise<boolean> {
  return (
    await git.statusMatrix({
      fs,
      dir: repo,
    })
  ).every(([_file, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1) // eslint-disable-line @typescript-eslint/no-unused-vars
}

interface GitFilestoreConfig {
  clone?: string
  local?: string
  branch?: string
  push?: boolean | string
}

export default {
  filestore: {
    configSchema: {
      type: "object",
      allOf: [
        {
          oneOf: [
            {
              properties: {
                clone: {
                  type: "string",
                  description: "A URL to an existing Git repository to be cloned for use as a filestore.",
                },
              },
              required: ["clone"],
            },
            {
              properties: {
                local: {
                  type: "string",
                  description: "A path to an existing Git repository that will be used as a filestore.",
                },
              },
              required: ["local"],
            },
          ],
        },
        {
          properties: {
            branch: {
              type: "string",
              nullable: true,
              description: "The branch on the Git repository to clone from/push to.",
            },
            push: {
              type: ["boolean", "string"],
              default: true,
              nullable: true,
              description:
                "Whether to push this filestore after committing. If a string, this also specifies the remote to push to instead of the default upstream.",
            },
          },
        },
      ],
      required: [],
    },
    async load(config) {
      if (!config.clone === !config.local) {
        throw "invalid config: exactly one of `config.clone` or `config.local` must be supplied (this should never occur)"
      }

      const remoteCreds = getEnvCredentials("CYANEA_GIT_REMOTE", "USERNAME", "PASSWORD")
      const commitCreds = getEnvCredentials("CYANEA_GIT_COMMIT", "KEY", { key: "PASSPHRASE", default: "" })

      const tempRepoFolder: string | null = null
      let repo: string
      if (config.clone) {
        repo = await cloneRepo(config.clone, config.branch, "filestore", remoteCreds)
      } else {
        repo = resolvePathOrThrow(process.cwd(), config.local!)
        if (!(await isRepoClean(repo))) {
          throw `Local filestore repository '${repo}' has uncommited changes`
        }
      }

      const files = new Map<string, Buffer>()

      return {
        async writeFile(file, data) {
          let buffer: Buffer
          if (typeof data === "string") {
            buffer = Buffer.from(data, "utf-8")
          } else {
            buffer = Buffer.from(data.buffer)
          }
          files.set(file, buffer)
        },

        async commit() {
          let head
          try {
            head = await git.resolveRef({ fs, dir: repo, ref: "HEAD" })
          } catch {
            // this is the first commit
            head = null
          }

          const tree: Map<string, TreeEntry> =
            head !== null
              ? new Map((await git.readTree({ fs, dir: repo, oid: head })).tree.map(x => [x.path, x]))
              : new Map()

          for (const [name, content] of files) {
            const blob = await git.writeBlob({ fs, dir: repo, blob: content })
            tree.set(name, { mode: "100644", path: name, oid: blob, type: "blob" })
          }
          const treeId = await git.writeTree({ fs, dir: repo, tree: [...tree.values()] })

          const author = { name: "Cyanea Git Bot", email: "cyanea-git@acmcyber.com" }
          await git.commit({
            fs,
            dir: repo,
            message: "Sync events",
            author,
            tree: treeId,
            signingKey: commitCreds?.key,
            onSign: async ({ payload, secretKey }) => {
              if (commitCreds === null) {
                throw "commitCreds are null in onSign callback - this should never happen!"
              }
              const encryptedPrivateKey = await openpgp.readPrivateKey({ armoredKey: secretKey })
              const privateKey =
                commitCreds.passphrase !== ""
                  ? await openpgp.decryptKey({ privateKey: encryptedPrivateKey, passphrase: commitCreds.passphrase })
                  : encryptedPrivateKey
              const signedMessage = await openpgp.sign({
                message: await openpgp.createCleartextMessage({ text: payload }),
                signingKeys: privateKey,
              })
              const signature = signedMessage.substring(signedMessage.indexOf("-----BEGIN PGP SIGNATURE-----"))
              return { signature }
            },
          })

          if (config.push !== false) {
            await git.push({
              fs,
              http,
              dir: repo,
              remote: typeof config.push === "string" ? config.push : undefined,
              onAuth: remoteCredentialsCallback(`push repository '${repo}'`, remoteCreds),
            })
          }

          if (tempRepoFolder !== null) {
            try {
              await fs.rm(tempRepoFolder, { recursive: true, force: true })
            } catch {
              console.warn(chalk.yellow(` warn: Couldn't clean up temporary filestore clone '${tempRepoFolder}'`))
            }
          }
        },
      }
    },
  },
} satisfies CyaneaPlugin<GitFilestoreConfig, undefined, undefined>
