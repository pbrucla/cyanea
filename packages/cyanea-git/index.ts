import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { resolvePathOrThrow } from "@pbrucla/cyanea-core/util/index.ts"
import fs from "node:fs/promises"
import Git from "nodegit"

async function cloneRepo(
  remote: string,
  branch: string | undefined,
  tempFolderPrefix: string,
): Promise<Git.Repository> {
  // make sure local file urls don't escape cwd
  if (remote.trim().startsWith("file://")) {
    remote = resolvePathOrThrow(process.cwd(), remote.trim().substring(7))
  } else if (!remote.match(/^([a-z][a-z0-9+\-.]*):\/\/.*?$/)) {
    remote = resolvePathOrThrow(process.cwd(), remote)
  }

  const path = await fs.mkdtemp(`cyanea-git-${tempFolderPrefix}`)
  return await Git.Clone(remote, path, branch ? { checkoutBranch: branch } : undefined)
}

// Check if the working directory of the given repository is clean.
async function isRepoClean(repo: Git.Repository): Promise<boolean> {
  return (
    (
      await repo.getStatus({
        flags: Git.Status.OPT.INCLUDE_UNTRACKED,
        show: Git.Status.SHOW.INDEX_AND_WORKDIR,
      })
    ).length == 0
  )
}

interface GitFilestoreConfig {
  clone?: string
  local?: string
  branch?: string
  push?: boolean
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
              type: "boolean",
              nullable: true,
              default: true,
              description: "Whether to push this filestore after committing.",
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

      let repo: Git.Repository
      if (config.clone) {
        repo = await cloneRepo(config.clone, config.branch, "cyanea-git-filestore")
      } else {
        const repoPath = resolvePathOrThrow(process.cwd(), config.local!)
        repo = await Git.Repository.open(repoPath)
        if (!(await isRepoClean(repo))) {
          throw `Local filestore repository '${repoPath}' has uncommited changes`
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
            head = await repo.getHeadCommit()
          } catch {
            // this is the first commit
            head = null
          }

          const tree = await Git.Treebuilder.create(repo, head ? await repo.getTree(head.treeId()) : undefined)
          for (const [name, content] of files) {
            const blob = await repo.createBlobFromBuffer(content)
            await tree.insert(name, blob, Git.TreeEntry.FILEMODE.BLOB)
          }
          const treeId = await tree.write()

          const author = Git.Signature.now("Cyanea Git Bot", "cyanea-git@acmcyber.com")
          await repo.createCommit("HEAD", author, author, "Sync events", treeId, head ? [head] : [])
          await repo.checkoutRef(await repo.getReference("HEAD"), { checkoutStrategy: Git.Checkout.STRATEGY.FORCE })
        },
      }
    },
  },
} satisfies CyaneaPlugin<GitFilestoreConfig, undefined, undefined>
