export const digiProfiles = [{
  id: 'digi', name: 'DIGI', family: 'digi',
  ssidLabels: ['SSID', 'WiFi Name', 'Network Name', 'Nombre WiFi'],
  passwordLabels: ['WiFi Password', 'WLAN Key', 'Clave WiFi'],
  securityLabels: ['Security', 'WPA', 'WPA2', 'WPA3', 'WEP'],
  negativeClues: ['Admin Password', 'WPS PIN', 'MAC', 'Serial'],
  ocrLabelTransforms: [{from:'SSlD',to:'SSID',scope:'label-only'}],
  identifiers: [
    { pattern: /\bdigi\s+spain\b/i, signal: 'DIGI Spain' },
    { pattern: /\bdigi\b/i, signal: 'DIGI' },
    { pattern: /\bdigifibra\b/i, signal: 'DIGIFIBRA' }
  ],
  vocabulary: ['DIGI', 'DIGI Spain', 'DIGIFIBRA'], positiveClues: ['DIGI', 'DIGI Spain', 'DIGIFIBRA'],
  labelHints: [/ssid/i, /wi[ -]?fi\s+(?:name|password|key)/i, /wlan\s+(?:key|password)/i],
  scoringRules: [
    { id: 'label-wifi-explicit', field: 'ssid', label: /ssid|wi[ -]?fi\s+name|network\s+name|nombre/i, delta: 5, reason: 'El perfil añade un refuerzo leve a un SSID con etiqueta explícita; no conoce un formato propio confirmado.' },
    { id: 'label-key-explicit', field: 'password', label: /wi[ -]?fi\s+(?:password|key)|wlan\s+(?:key|password)|wpa/i, delta: 5, reason: 'El perfil añade un refuerzo leve a una clave Wi-Fi etiquetada; no conoce un formato propio confirmado.' }
  ]
}];
