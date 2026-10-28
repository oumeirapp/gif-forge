'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SAS_LIFETIME_MS = 60 * 60 * 1000;
const DELEGATION_KEY_LIFETIME_MS = 6 * 60 * 60 * 1000;

const CONTENT_TYPES = {
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function attachmentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// Files stay in the job's output directory and are streamed by the download route.
function createLocalStorage() {
  return {
    kind: 'local',
    async save({ filePath }) {
      return { fileName: path.basename(filePath), filePath };
    },
    async send(reply, entry) {
      const stat = await fsp.stat(entry.filePath);
      reply
        .header('Content-Type', contentTypeFor(entry.fileName))
        .header('Content-Length', stat.size)
        .header('Content-Disposition', attachmentDisposition(entry.fileName))
        .header('Cache-Control', 'private, no-store');
      return reply.send(fs.createReadStream(entry.filePath));
    },
  };
}

// Outputs are uploaded to <container>/<owner>/<jobId>/<fileName>; downloads redirect to a
// read-only SAS URL. A Blob lifecycle rule (7 days) handles cleanup.
function createBlobStorage(azure) {
  const {
    BlobServiceClient,
    BlobSASPermissions,
    generateBlobSASQueryParameters,
  } = require('@azure/storage-blob');

  let serviceClient;
  if (azure.connectionString) {
    serviceClient = BlobServiceClient.fromConnectionString(azure.connectionString);
  } else if (azure.account) {
    const { DefaultAzureCredential } = require('@azure/identity');
    serviceClient = new BlobServiceClient(`https://${azure.account}.blob.core.windows.net`, new DefaultAzureCredential());
  } else {
    throw new Error('STORAGE=blob needs AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT.');
  }
  const containerClient = serviceClient.getContainerClient(azure.container);
  let delegationKey = null;

  async function userDelegationKey() {
    const now = Date.now();
    if (delegationKey && delegationKey.expiresOn - now > SAS_LIFETIME_MS) return delegationKey.value;
    const startsOn = new Date(now - 5 * 60 * 1000);
    const expiresOn = new Date(now + DELEGATION_KEY_LIFETIME_MS);
    const value = await serviceClient.getUserDelegationKey(startsOn, expiresOn);
    delegationKey = { value, expiresOn: expiresOn.getTime() };
    return value;
  }

  return {
    kind: 'blob',
    async save({ owner, jobId, filePath }) {
      const fileName = path.basename(filePath);
      const blobName = `${owner}/${jobId}/${fileName}`;
      await containerClient.getBlockBlobClient(blobName).uploadFile(filePath, {
        blobHTTPHeaders: { blobContentType: contentTypeFor(fileName) },
      });
      await fsp.rm(filePath, { force: true });
      return { fileName, blobName };
    },
    async send(reply, entry) {
      const blobClient = containerClient.getBlobClient(entry.blobName);
      const startsOn = new Date(Date.now() - 5 * 60 * 1000);
      const expiresOn = new Date(Date.now() + SAS_LIFETIME_MS);
      const sasOptions = {
        containerName: azure.container,
        blobName: entry.blobName,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
        contentDisposition: attachmentDisposition(entry.fileName),
      };
      let url;
      if (azure.connectionString) {
        url = await blobClient.generateSasUrl(sasOptions);
      } else {
        const query = generateBlobSASQueryParameters(sasOptions, await userDelegationKey(), serviceClient.accountName);
        url = `${blobClient.url}?${query.toString()}`;
      }
      return reply.header('Cache-Control', 'private, no-store').redirect(url, 302);
    },
  };
}

function createStorage(config) {
  return config.storage === 'blob' ? createBlobStorage(config.azure) : createLocalStorage();
}

module.exports = { attachmentDisposition, contentTypeFor, createStorage, createLocalStorage };
