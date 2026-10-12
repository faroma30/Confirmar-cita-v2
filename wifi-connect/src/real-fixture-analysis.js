import {parseRouterLabel} from './router-parser.js';

function fieldMatch(value, expected) {
  return expected == null || expected === '' || expected === 'REDACTED' ? null : String(value ?? '').normalize('NFC') === String(expected).normalize('NFC');
}

export function analyzeRealFixtureText(text, expected = {}) {
  const generic = parseRouterLabel({rawText:text, normalizedText:text}, {operatorProfiles:false});
  const profiled = parseRouterLabel({rawText:text, normalizedText:text}, {operatorProfiles:true});
  const top = result => ({ssid:result.ssidCandidates[0] ?? null, ssids:result.ssidCandidates.filter(candidate=>candidate.score>=70), password:result.passwordCandidates[0] ?? null, security:result.security, operator:result.operator?.detected ?? null});
  const genericTop = top(generic), profiledTop = top(profiled);
  const matches = (result, profileResult) => ({
    operator: expected.operator === 'unknown' ? (profileResult?.operator?.detected ? false : true) : expected.operator == null || expected.operator === '' ? null : fieldMatch(profileResult?.operator?.detected?.id, expected.operator),
    ssid: expected.ssids?.length
      ? expected.ssids.every(value=>profileResult.ssidCandidates.some(candidate=>candidate.value===value))
      : fieldMatch(result.ssid?.value, expected.ssid),
    password: fieldMatch(result.password?.value, expected.password),
    security: fieldMatch(result.security?.value, expected.security),
  });
  const genericMatches=matches(genericTop,generic),match=matches(profiledTop,profiled);
  return {
    generic: {top:genericTop, matches:genericMatches},
    profiled: {top:profiledTop, matches:match, appliedProfiles:profiled.appliedProfiles, profileDiagnostics:profiled.profileDiagnostics},
    differences: {
      ssidValueChanged:genericTop.ssid?.value !== profiledTop.ssid?.value,
      passwordValueChanged:genericTop.password?.value !== profiledTop.password?.value,
      ssidScoreDelta:(profiledTop.ssid?.score ?? 0)-(genericTop.ssid?.score ?? 0),
      passwordScoreDelta:(profiledTop.password?.score ?? 0)-(genericTop.password?.score ?? 0),
    },
  };
}

export function summarizeRealFixtures(records = []) {
  const operators = ['digi','movistar','o2','orange','jazztel','vodafone','lowi'];
  return Object.fromEntries(operators.map(operator => {
    const samples=records.filter(item=>item.operator===operator && item.status==='reviewed');
    const count=field=>samples.filter(item=>item[field]===true).length;
    return [operator,{
      samples:samples.length,
      operatorCorrect:count('operatorCorrect'), ssidCorrect:count('ssidCorrect'), passwordCorrect:count('passwordCorrect'), securityCorrect:count('securityCorrect'),
      manualCorrections:samples.filter(item=>item.manualCorrection===true).length,
      ocrErrors:samples.filter(item=>item.ocrCorrect===false).length,
      parserErrors:samples.filter(item=>item.parserCorrect===false).length,
    }];
  }));
}
