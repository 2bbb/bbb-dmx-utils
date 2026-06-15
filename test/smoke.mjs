import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = join(tmpdir(), 'bbb-dmx-convert-smoke');
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });

function run(args) {
  execFileSync(process.execPath, [join(root, 'dist/index.js'), ...args], { stdio: 'inherit' });
}

function cliOutput(bin, args) {
  return execFileSync(process.execPath, [join(root, `dist/${bin}.js`), ...args], { encoding: 'utf8' });
}

function npmOutput(args) {
  if(process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, 'run', ...args], { cwd: root, encoding: 'utf8' });
  }
  const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmBinary, ['run', ...args], { cwd: root, encoding: 'utf8' });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function assertClose(actual, expected, label, epsilon = 1.0e-6) {
  if(Math.abs(actual - expected) > epsilon) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const convertNoArgHelp = cliOutput('index', []);
if(!convertNoArgHelp.includes('Usage: bbb-dmx-convert') || !convertNoArgHelp.includes('Commands:') || !convertNoArgHelp.includes('Supported inputs:') || !convertNoArgHelp.includes('npm examples:')) {
  throw new Error(`bbb-dmx-convert without args should print CLI help, got: ${convertNoArgHelp}`);
}
const lintNoArgHelp = cliOutput('lint', []);
if(!lintNoArgHelp.includes('Usage: bbb-dmx-lint') || !lintNoArgHelp.includes('--fixture-dir')) {
  throw new Error(`bbb-dmx-lint without args should print CLI help, got: ${lintNoArgHelp}`);
}
const npmConvertHelp = npmOutput(['convert', '--', '--help']);
if(!npmConvertHelp.includes('Usage: bbb-dmx-convert') || !npmConvertHelp.includes('Supported inputs:')) {
  throw new Error(`npm run convert should expose converter help, got: ${npmConvertHelp}`);
}
const npmConvertCommandHelp = npmOutput(['convert', '--', 'convert', '--help']);
if(!npmConvertCommandHelp.includes('Output layout:') || !npmConvertCommandHelp.includes('--patch is mainly for scene formats such as MVR')) {
  throw new Error(`npm run convert -- convert --help should explain output behavior, got: ${npmConvertCommandHelp}`);
}
const npmLintHelp = npmOutput(['lint', '--', '--help']);
if(!npmLintHelp.includes('Usage: bbb-dmx-lint')) {
  throw new Error(`npm run lint should expose linter help, got: ${npmLintHelp}`);
}

run(['convert', join(root, 'test/minimal.gdtf.xml'), '--format', 'gdtf-xml', '--out-dir', join(temp, 'xml'), '--overwrite']);
const minimalProfile = readJson(join(temp, 'xml/fixtures/exampleco.tiny.rgb.mover.json'));
if(minimalProfile.photometry?.beam_angle_degrees !== 4.5 || minimalProfile.photometry?.field_angle_degrees !== 25.0 || minimalProfile.photometry?.beam_radius !== 0.052 || minimalProfile.photometry?.luminous_flux !== 1000 || minimalProfile.photometry?.color_temperature !== 6500) {
  throw new Error(`GDTF Beam photometry was not converted correctly: ${JSON.stringify(minimalProfile.photometry)}`);
}
const shutterRanges = minimalProfile.modes.basic?.parameters?.shutter?.ranges;
if(!Array.isArray(shutterRanges) || shutterRanges.length !== 6) {
  throw new Error(`GDTF shutter ChannelFunction/ChannelSet ranges were not converted: ${JSON.stringify(shutterRanges)}`);
}
const expectedShutterRanges = [
  { from: 0, to: 31, function: 'closed', label: 'Closed' },
  { from: 32, to: 63, function: 'open', label: 'Open' },
  { from: 64, to: 127, function: 'strobe', label: 'Strobe', physical_from: 0.5, physical_to: 10 },
  { from: 128, to: 191, function: 'pulse', label: 'Pulse' },
  { from: 192, to: 223, function: 'random', label: 'Random' },
  { from: 224, to: 255, function: 'open', label: 'Open' },
];
for(const [index, expected] of expectedShutterRanges.entries()) {
  const actual = shutterRanges[index];
  for(const [key, value] of Object.entries(expected)) {
    if(actual?.[key] !== value) {
      throw new Error(`GDTF shutter range ${index} ${key}: expected ${value}, got ${JSON.stringify(actual)}`);
    }
  }
}
const wheels = minimalProfile.wheels;
if(!Array.isArray(wheels) || wheels[0]?.id !== 'colorwheel1' || wheels[0]?.type !== 'color') {
  throw new Error(`GDTF color wheel metadata was not converted: ${JSON.stringify(wheels)}`);
}
if(wheels[0].slots?.[1]?.label !== 'Red' || !Array.isArray(wheels[0].slots?.[1]?.cie_xyY)) {
  throw new Error(`GDTF color wheel slot color was not preserved: ${JSON.stringify(wheels[0].slots)}`);
}
const colorWheelParam = minimalProfile.modes.basic?.parameters?.color;
if(colorWheelParam?.wheel !== 'colorwheel1') {
  throw new Error(`GDTF color ChannelFunction Wheel was not linked: ${JSON.stringify(colorWheelParam)}`);
}
const colorWheelRanges = colorWheelParam?.ranges;
if(!Array.isArray(colorWheelRanges) || colorWheelRanges[1]?.wheel_slot !== 2 || colorWheelRanges[1]?.function !== 'red') {
  throw new Error(`GDTF ChannelSet WheelSlotIndex was not converted: ${JSON.stringify(colorWheelRanges)}`);
}

const repeatedAttributeXml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF>
  <FixtureType Name="Two Dimmer" LongName="Two Dimmer" Manufacturer="ExampleCo">
    <DMXModes>
      <DMXMode Name="Basic">
        <DMXChannels>
          <DMXChannel Offset="1"><LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" Default="0/1" /></LogicalChannel></DMXChannel>
          <DMXChannel Offset="2"><LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" Default="0/1" /></LogicalChannel></DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>
`;
writeFileSync(join(temp, 'repeated.gdtf.xml'), repeatedAttributeXml);
run(['convert', join(temp, 'repeated.gdtf.xml'), '--format', 'gdtf-xml', '--out-dir', join(temp, 'repeated'), '--overwrite']);
const repeatedProfile = readJson(join(temp, 'repeated/fixtures/exampleco.two.dimmer.json'));
const repeatedMode = repeatedProfile.modes.basic;
const channelKeys = repeatedMode.channels.map((channel) => channel.key);
if(new Set(channelKeys).size !== channelKeys.length) {
  throw new Error(`repeated attribute conversion emitted duplicate channel keys: ${channelKeys.join(', ')}`);
}
if(channelKeys[0] !== 'dimmer' || channelKeys[1] !== 'dimmer_2') {
  throw new Error(`repeated attribute channel keys were not uniquified as expected: ${channelKeys.join(', ')}`);
}
if(repeatedMode.parameters.dimmer?.channel !== 'dimmer' || repeatedMode.parameters.dimmer_2?.channel !== 'dimmer_2') {
  throw new Error('repeated attribute parameters do not address their own unique channel keys');
}

const gdtf = new JSZip();
gdtf.file('description.xml', readFileSync(join(root, 'test/minimal.gdtf.xml')));
const gdtfData = await gdtf.generateAsync({ type: 'nodebuffer' });

const mvr = new JSZip();
mvr.file('Tiny RGB Mover.gdtf', gdtfData);
mvr.file('GeneralSceneDescription.xml', `<?xml version="1.0"?>
<GeneralSceneDescription>
  <Scene>
    <Fixtures>
      <Fixture Name="Spot 1" UUID="00000000-0000-0000-0000-000000000001" GDTFSpec="Tiny RGB Mover.gdtf" GDTFMode="Basic">
        <Matrix>{1.000000,0.000000,0.000000}{0.000000,-1.000000,0.000000}{0.000000,0.000000,-1.000000}{-2000.000000,1500.000000,4000.000000}</Matrix>
        <Addresses><Address Universe="2" Address="17" /></Addresses>
      </Fixture>
      <Fixture Name="Spot 1" UUID="00000000-0000-0000-0000-000000000002" GDTFSpec="Tiny RGB Mover.gdtf" GDTFMode="Basic">
        <Addresses><Address Universe="2" Address="30" /></Addresses>
      </Fixture>
    </Fixtures>
  </Scene>
</GeneralSceneDescription>
`);
writeFileSync(join(temp, 'scene.mvr'), await mvr.generateAsync({ type: 'nodebuffer' }));

run(['convert', join(temp, 'scene.mvr'), '--format', 'mvr', '--out-dir', join(temp, 'mvr'), '--patch', 'patches/from-mvr.json', '--overwrite']);
const patch = readJson(join(temp, 'mvr/patches/from-mvr.json'));
if(patch.schema !== 'bbb.dmx.patch.v2' || patch.coordinates !== 'gdtf') {
  throw new Error(`MVR patch should declare v2/gdtf, got ${patch.schema}/${patch.coordinates}`);
}
const fixture = patch.fixtures?.[0];
const duplicateNameFixture = patch.fixtures?.[1];
if(fixture?.universe !== 2 || fixture?.address !== 17 || duplicateNameFixture?.universe !== 2 || duplicateNameFixture?.address !== 30) {
  throw new Error('MVR smoke patch did not preserve universe/address');
}
if(fixture.id !== 'spot_1' || duplicateNameFixture.id !== 'spot_1_2') {
  throw new Error(`MVR fixture ids should prefer readable Name over UUID and uniquify duplicates, got ${fixture.id}, ${duplicateNameFixture.id}`);
}
assertClose(fixture.position[0], -2.0, 'MVR matrix position.x');
assertClose(fixture.position[1], 1.5, 'MVR matrix position.y');
assertClose(fixture.position[2], 4.0, 'MVR matrix position.z');
assertClose(fixture.rotation[0], 180.0, 'MVR matrix rotation.x');
assertClose(fixture.rotation[1], 0.0, 'MVR matrix rotation.y');
assertClose(fixture.rotation[2], 0.0, 'MVR matrix rotation.z');

function lint(args, options = {}) {
  return execFileSync(process.execPath, [join(root, 'dist/lint.js'), ...args], { stdio: options.stdio ?? 'inherit' });
}

lint([
  join(root, 'test/data/fixtures/generic.mover.16bit.json'),
  join(root, 'test/data/patches/example.json'),
  join(root, 'test/data/maps/rgb-grid.example.json'),
  join(root, 'test/data/palettes/example.json'),
  join(root, 'test/data/scenes/example.json'),
  join(root, 'test/data/curves/example.json'),
  join(root, 'test/data/masks/example.json'),
  join(root, 'test/data/asserts/example.json')
]);
lint([join(temp, 'mvr/patches/from-mvr.json'), '--fixture-dir', join(temp, 'mvr/fixtures')]);

const badPatch = {
  schema: 'bbb.dmx.patch.v2',
  coordinates: 'gdtf',
  fixtures: [
    { id: 'spot_a', profile: 'generic.mover.16bit', mode: 'basic16', universe: 1, address: 1 },
    { id: 'spot_b', profile: 'generic.mover.16bit', mode: 'basic16', universe: 1, address: 2 }
  ]
};
writeFileSync(join(temp, 'bad-overlap.json'), JSON.stringify(badPatch, null, 2));
let failedAsExpected = false;
try {
  lint([join(temp, 'bad-overlap.json'), '--fixture-dir', join(root, 'test/data/fixtures')], { stdio: 'pipe' });
} catch(error) {
  failedAsExpected = true;
  const stderr = error.stderr?.toString() ?? '';
  if(!stderr.includes('overlaps')) {
    throw new Error(`bbb-dmx-lint failed for the wrong reason: ${stderr}`);
  }
}
if(!failedAsExpected) {
  throw new Error('bbb-dmx-lint did not reject an overlapping patch');
}

const gapProfile = {
  schema: 'bbb.dmx.fixture.profile.v1',
  key: 'gap.profile',
  manufacturer: 'ExampleCo',
  model: 'Gap Profile',
  modes: {
    basic: {
      label: 'Basic',
      footprint: 1,
      channels: [{ offset: 1, key: 'shutter' }],
      parameters: {
        shutter: {
          type: 'u8',
          channel: 'shutter',
          ranges: [
            { from: 0, to: 31, function: 'closed' },
            { from: 64, to: 255, function: 'open' }
          ]
        }
      }
    }
  }
};
writeFileSync(join(temp, 'gap-profile.json'), JSON.stringify(gapProfile, null, 2));
failedAsExpected = false;
try {
  lint([join(temp, 'gap-profile.json'), '--strict'], { stdio: 'pipe' });
} catch(error) {
  failedAsExpected = true;
  const stderr = error.stderr?.toString() ?? '';
  if(!stderr.includes('gap 32..63')) {
    throw new Error(`bbb-dmx-lint strict failed for the wrong range reason: ${stderr}`);
  }
}
if(!failedAsExpected) {
  throw new Error('bbb-dmx-lint --strict did not reject a parameter range gap warning');
}
