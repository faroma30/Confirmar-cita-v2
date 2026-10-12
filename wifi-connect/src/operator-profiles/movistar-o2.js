const shared = {
  ssidLabels: ['SSID', 'WiFi Name', 'Network Name', 'Nombre WiFi'],
  passwordLabels: ['WiFi Password', 'WLAN Key', 'Clave WiFi'],
  securityLabels: ['Security', 'WPA', 'WPA2', 'WPA3', 'WEP'],
  positiveClues: [], negativeClues: ['Admin Password', 'WPS PIN', 'MAC', 'Serial'],
  ocrLabelTransforms: [{from:'SSlD',to:'SSID',scope:'label-only'}],
  family: 'telefonica',
  labelHints: [/ssid/i, /wi[ -]?fi|wlan/i],
  scoringRules: [
    { id: 'explicit-wifi-label', field: 'ssid', label: /ssid|wi[ -]?fi\s+name|nombre|network\s+name/i, delta: 5, reason: 'Refuerzo leve por etiqueta Wi-Fi explícita, sin asumir un formato de router.' },
    { id: 'explicit-key-label', field: 'password', label: /wi[ -]?fi|wlan|clave|password|key/i, delta: 5, reason: 'Refuerzo leve por etiqueta de clave explícita, sin asumir un formato de router.' }
  ]
};
export const movistarO2Profiles = [
  { ...shared, id: 'movistar', name: 'Movistar', identifiers: [{ pattern: /\bmovistar\b/i, signal: 'Movistar' }, { pattern: /\bmov[i1l]star\b/i, signal: 'MOVlSTAR (OCR aproximado)', fuzzy: true }], vocabulary: ['Movistar'], positiveClues: ['Movistar'] },
  { ...shared, id: 'o2', name: 'O2', identifiers: [{ pattern: /(?:^|[^\p{L}\p{N}])o2(?:$|[^\p{L}\p{N}])/iu, signal: 'O2' }], vocabulary: ['O2'], positiveClues: ['O2'] },
  { ...shared, id: 'telefonica', name: 'Telefónica (familia)', identifiers: [{ pattern: /\btelefonica\b/i, signal: 'Telefónica' }], vocabulary: ['Telefónica'], positiveClues: ['Telefónica'] }
];
