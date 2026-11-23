// Split labels, not values: substring matches would also select author/tokenizer.
export function labelWords(name) {
  return name.replace(/^-[PD]/, '').replace(/^ORG_GRADLE_PROJECT_/i, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[\s._:/-]+/).filter(Boolean);
}

const labels = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token',
  'apikey', 'accesskey', 'credential', 'credentials', 'auth', 'signature', 'cookie',
  'session', 'license', 'licence', 'keystore', 'key', 'appkey', 'privatekey',
  'signkey', 'magicword', 'storepass', 'keypass', 'storepassword', 'keypassword',
  'licensekey', 'licencekey', 'keystorepassword', 'keyaliaspassword', 'signingkey',
  'oauth', 'tokens', 'xpassword']);
const repositories = new Set(['nexus', 'artifactory', 'maven', 'sonatype', 'ossrh']);

export function credentialLabel(name) {
  name = name.replace(/^-[PD]/, '').replace(/^ORG_GRADLE_PROJECT_/i, '');
  // This SSH operation name prefixes a routing diagnostic, not a session value.
  if (/^mux_client_request_session$/i.test(name)) return false;
  if (/^key[._-]?alias$/i.test(name)) return false;
  if (/^(?:nexus|artifactory|maven|sonatype|ossrh)(?:[._-]|user|login|pass|pwd|token|secret|magic|auth|credential|key)/i.test(name))
    return true;
  if (/^signing\./i.test(name)) return true;
  // Check delimiter-separated spelling too, even when its casing is irregular.
  const separated = name.toLowerCase().split(/[\s._:/-]+/).filter(Boolean);
  for (const words of [separated, labelWords(name)]) {
    if (words.length > 1 && (words.includes('pass') || repositories.has(words[0]))) return true;
    if (words.some(word => labels.has(word))) return true;
    for (let i = 0; i < words.length - 1; i++) {
      const pair = words[i] + ' ' + words[i + 1];
      if (/^(?:(?:api|access|private|sign|signing|license|licence) key|magic word|(?:store|key) pass)$/.test(pair))
        return true;
    }
    if (words.some(word => /^(?:repo|repository)$/.test(word))
      && words.some(word => /^(?:user|username)$/.test(word))) return true;
  }
  return false;
}
