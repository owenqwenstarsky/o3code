import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  type ChangeRequestHostIdentity,
  type ChangeRequestProjectIdentity,
  defineSourceControl,
  type SourceControlDefinition,
  type SourceControlIcon,
  isChangeRequestAuthorityOfProject,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";

const CHANGE_REQUEST_REFERENCE =
  /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+[^/\s]+\/pulls\/(\d+)(?:[/?#].*)?$/i;

// Forgejo and Gitea run on any hostname, possibly mounted below a path.
const CHANGE_REQUEST_PATH = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+(?:\/[^/]+)+)\/commit\/([0-9a-f]+)\/?$/iu;

const changeRequestHeadRef = (number: number) => `refs/pull/${number}/head`;

/**
 * The repository's browser URL the server resolved from the signed-in account, which is the
 * only place a server mounted below a path says so.
 */
function resolvedWebUrl(identity: ChangeRequestProjectIdentity): URL | null {
  if (!identity.webUrl) return null;
  try {
    const url = new URL(identity.webUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export interface GiteaFamilyOptions {
  readonly kind: string;
  readonly label: string;
  readonly pickerLabel: string;
  readonly icon: SourceControlIcon;
  readonly searchKeywords: ReadonlyArray<string>;
  readonly publicHost: string;
  /** Whether a remote on `hostname` is this host's without a login to say so. */
  readonly recognizesHostname: (hostname: string) => boolean;
  /** Whether a pull request or commit link on `hostname` is presented as this host's. */
  readonly claimsLinkHostname: (hostname: string) => boolean;
  readonly checkoutCommand: SourceControlDefinition["checkoutCommand"];
  readonly checkoutCommandArgument: SourceControlDefinition["checkoutCommandArgument"];
  readonly changeRequestCloseCommand: RegExp;
}

/** Forgejo and Gitea share their web routes, so both definitions differ only in these options. */
export function giteaFamilyDefinition(options: GiteaFamilyOptions) {
  const kind = SourceControlProviderKind.make(options.kind);
  /** A server's identity includes its port, which only an HTTP remote names. */
  const changeRequestHost = (identity: ChangeRequestHostIdentity): string => {
    try {
      const remote = new URL(identity?.locator?.remoteUrl ?? "");
      if (remote.protocol === "http:" || remote.protocol === "https:") {
        return remote.host.toLowerCase();
      }
    } catch {
      // SSH remotes do not name the web server.
    }
    return projectChangeRequestHost(identity, kind);
  };
  return defineSourceControl({
    kind,
    label: options.label,
    pickerLabel: options.pickerLabel,
    icon: options.icon,
    searchKeywords: options.searchKeywords,
    changeRequest: {
      shortLabel: "PR",
      shortLabelWithArticle: "a PR",
      singular: "pull request",
      plural: "pull requests",
    },
    repositoryPathHint: "owner/repo",
    publicHost: options.publicHost,
    publishDescription: "Your signed-in server",
    publishHost: (signedInHost) => signedInHost ?? "your server",
    newRepositoryOwner: (account) => (account ? { owner: account } : null),
    defaultCloneTransport: "https",
    // The server's resolved web URL wins; otherwise an HTTP remote on the same host names the
    // origin, which may carry a port. SSH remotes say nothing about the web origin.
    changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
      webUrl
        ? changeRequestUrlBelow(webUrl, `pulls/${number}`)
        : `${remoteWebOrigin(host, remoteUrl)}/${repository}/pulls/${number}`,
    // A server's identity includes its port, so the link carries it.
    parseChangeRequestUrl: (url) => {
      if (!options.claimsLinkHostname(url.hostname.toLowerCase())) return null;
      const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
      return link === null ? null : { ...link, authority: url.host.toLowerCase() };
    },
    changeRequestUrlFromReferenceAutolink: () => null,
    commitUrl: (input) => buildCommitUrl(input, "commit"),
    parseCommitUrl: (url, known) =>
      known || options.claimsLinkHostname(url.hostname.toLowerCase())
        ? parseCommitPath(url, COMMIT_PATH)
        : null,
    changeRequestActions: new Set(["merge", "close", "reopen", "update-branch"] as const),
    checkoutCommand: options.checkoutCommand,
    changeRequestCloseCommand: options.changeRequestCloseCommand,
    authorProfileUrl: () => null,
    hardLineBreaks: true,
    // Forgejo and Gitea refuse a change request review without a summary, even with inline
    // comments.
    reviewSummaryRequired: (verdict) => verdict === "request-changes",
    checkoutCommandArgument: options.checkoutCommandArgument,
    isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
    checkoutChangeRequestHost: () => null,
    changeRequestHeadRef,
    recognizeRemote: ({ remoteUrl, host, hostname }) =>
      options.recognizesHostname(hostname)
        ? {
            kind,
            name: options.label,
            baseUrl: /^https?:/iu.test(remoteUrl) ? new URL(remoteUrl).origin : `https://${host}`,
          }
        : null,
    changeRequestHost,
    isChangeRequestInRepository: (identity, link) => {
      if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
      const web = resolvedWebUrl(identity);
      if (!web)
        return isChangeRequestInProjectRepository(changeRequestHost(identity), identity, link);
      return (
        web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
        web.pathname.replace(/^\/+|\/+$/g, "").toLowerCase() === link.repository.toLowerCase()
      );
    },
    // A server mounted below a path serves only repositories under that mount.
    canReadChangeRequestOnHost: (identity, link) => {
      const web = resolvedWebUrl(identity);
      if (!web) return isChangeRequestOnProjectHost(changeRequestHost(identity), identity, link);
      const mount = web.pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .slice(0, -2)
        .join("/");
      return (
        web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
        (!mount || link.repository.toLowerCase().startsWith(`${mount.toLowerCase()}/`))
      );
    },
  });
}

/** gitea.com, or a hostname with a `gitea` label such as `git.gitea.example`. */
export const isGiteaHostname = (hostname: string) =>
  hostname === "gitea.com" || hostname.split(".").includes("gitea");
