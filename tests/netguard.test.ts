import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedUrlSync, isPrivateAddress } from '../src/html/netguard.ts';

describe('SSRF guard', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('blocks private hosts and non-http schemes without DNS', () => {
    for (const u of ['http://localhost:8790/api', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://[::1]/', 'ftp://example.com', 'http://foo.internal/'])
      expect(isBlockedUrlSync(u), u).toBe(true);
    expect(isBlockedUrlSync('https://example.com/menu')).toBe(false);
  });
  it('rejects private targets before fetching', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8790/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://metadata.localhost/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });
});

describe('SSRF guard — IPv6 forms of private IPv4 (review finding)', () => {
  it('blocks IPv4-mapped / compatible / NAT64 addresses in any notation', async () => {
    const { isBlockedUrlSync } = await import('../src/html/netguard.ts');
    for (const u of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data',
      'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
      'http://[::a9fe:a9fe]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
    ])
      expect(isBlockedUrlSync(u), u).toBe(true);
    expect(isBlockedUrlSync('http://[2606:4700::6810:84e5]/')).toBe(false);
  });
});
