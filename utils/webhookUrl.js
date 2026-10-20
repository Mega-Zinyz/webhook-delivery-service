const dns = require('node:dns').promises;
const net = require('node:net');

const privateEndpointOptIn = process.env.WEBHOOK_ALLOW_PRIVATE_ENDPOINTS === 'true';
const blockedIpv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([address, prefix]) => [ipv4ToNumber(address), prefix]);

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0) >>> 0;
}

function isInIpv4Range(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (network & mask);
}

function isPublicIpv4(address) {
  return net.isIP(address) === 4
    && !blockedIpv4Ranges.some(([network, prefix]) => isInIpv4Range(address, network, prefix));
}

function ipv6ToBigInt(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  let value = normalized;
  if (ipv4Match) {
    const ipv4 = ipv4ToNumber(ipv4Match[1]);
    value = `${normalized.slice(0, -ipv4Match[1].length)}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv6Range(value, network, prefix) {
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (network >> shift);
}

function isPublicIpv6(address) {
  if (net.isIP(address) !== 6) {
    return false;
  }
  const value = ipv6ToBigInt(address);
  if (value === null) {
    return false;
  }

  const globalUnicast = isInIpv6Range(value, 0x20000000000000000000000000000000n, 3);
  const documentation = isInIpv6Range(value, 0x20010db8000000000000000000000000n, 32);
  const protocolAssignments = isInIpv6Range(value, 0x20010000000000000000000000000000n, 23);
  const sixToFour = isInIpv6Range(value, 0x20020000000000000000000000000000n, 16);
  return globalUnicast && !documentation && !protocolAssignments && !sixToFour;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return isPublicIpv4(address);
  }
  if (family === 6) {
    const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mappedIpv4 ? isPublicIpv4(mappedIpv4[1]) : isPublicIpv6(address);
  }
  return false;
}

async function resolveAllowedAddresses(hostname, allowPrivate = privateEndpointOptIn) {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await dns.lookup(normalizedHostname, { all: true, verbatim: true });

  if (addresses.length === 0) {
    throw new Error('Webhook endpoint hostname did not resolve to an IP address');
  }
  if (!allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook endpoint must resolve only to public IP addresses');
  }
  return addresses;
}

async function validateWebhookUrl(endpointUrl, allowPrivate = privateEndpointOptIn) {
  let parsedUrl;
  try {
    parsedUrl = new URL(endpointUrl);
  } catch {
    throw new Error('endpointUrl must be a valid HTTP or HTTPS URL');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('endpointUrl must be an HTTP or HTTPS URL without credentials');
  }

  await resolveAllowedAddresses(parsedUrl.hostname, allowPrivate);
  return parsedUrl;
}

function safeLookup(hostname, options, callback) {
  resolveAllowedAddresses(hostname)
    .then((addresses) => {
      const compatibleAddresses = options.family
        ? addresses.filter(({ family }) => family === options.family)
        : addresses;
      if (compatibleAddresses.length === 0) {
        callback(new Error('Webhook endpoint has no address matching the requested IP family'));
        return;
      }
      if (options.all) {
        callback(null, compatibleAddresses);
      } else {
        const [{ address, family }] = compatibleAddresses;
        callback(null, address, family);
      }
    })
    .catch(callback);
}

module.exports = { isPublicAddress, safeLookup, validateWebhookUrl };
