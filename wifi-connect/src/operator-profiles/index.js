import {digiProfiles} from './digi.js';
import {movistarO2Profiles} from './movistar-o2.js';
import {orangeJazztelProfiles} from './orange-jazztel.js';
import {vodafoneLowiProfiles} from './vodafone-lowi.js';

export const operatorProfiles = Object.freeze([
  ...digiProfiles, ...movistarO2Profiles, ...orangeJazztelProfiles, ...vodafoneLowiProfiles
]);
export const getOperatorProfile = id => operatorProfiles.find(profile => profile.id === id) || null;
