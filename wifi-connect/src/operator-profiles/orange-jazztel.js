const shared = {
  ssidLabels: ['SSID', 'WiFi Name', 'Network Name', 'Nombre WiFi'],
  passwordLabels: ['WiFi Password', 'WLAN Key', 'Clave WiFi'],
  securityLabels: ['Security', 'WPA', 'WPA2', 'WPA3', 'WEP'],
  positiveClues: [], negativeClues: ['Admin Password', 'WPS PIN', 'MAC', 'Serial'],
  ocrLabelTransforms: [{from:'SSlD',to:'SSID',scope:'label-only'}],
  family: 'orange-group',
  labelHints: [/ssid/i, /wi[ -]?fi|wlan/i],
  scoringRules: [
    { id: 'explicit-wifi-label', field: 'ssid', label: /ssid|wi[ -]?fi\s+name|nombre|network\s+name/i, delta: 5, reason: 'Refuerzo leve por etiqueta Wi-Fi explícita, no por formato supuesto.' },
    { id: 'explicit-key-label', field: 'password', label: /wi[ -]?fi|wlan|password|key|clave/i, delta: 5, reason: 'Refuerzo leve por etiqueta de clave explícita, no por formato supuesto.' }
  ]
};
export const orangeJazztelProfiles = [
  { ...shared, id: 'orange', name: 'Orange', identifiers: [{ pattern: /\borange\b/i, signal: 'Orange' }], vocabulary: ['Orange'], positiveClues: ['Orange'] },
  { ...shared, id: 'jazztel', name: 'Jazztel', identifiers: [{ pattern: /\bjazztel\b/i, signal: 'Jazztel' }], vocabulary: ['Jazztel'], positiveClues: ['Jazztel'] }
];
