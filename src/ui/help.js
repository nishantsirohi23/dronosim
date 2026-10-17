import { FC_PARAMS } from '../config.js';
import { MODES, MODE_INFO } from '../fc/flightController.js';

const KEYS = [
  ['Flying (Mode 2)', [
    ['W / S', 'Throttle up / down (stays where you leave it, like an RC throttle stick). Hold Shift for faster.'],
    ['A / D', 'Yaw left / right'],
    ['Arrow Up / Down', 'Pitch forward / back'],
    ['Arrow Left / Right', 'Roll left / right'],
    ['E', 'Set throttle to 50% (hover / hold position in Alt Hold and Loiter)'],
    ['Q', 'Throttle to zero'],
  ]],
  ['Arming and safety', [
    ['Enter', 'Arm / disarm (disarm only when landed)'],
    ['Throttle down + yaw right 2 s', 'Stick arm'],
    ['Throttle down + yaw left 2 s', 'Stick disarm (on the ground)'],
    ['X then X (within 1 s)', 'EMERGENCY motor stop (also double-click E-STOP)'],
    ['R', 'Reset drone to the pad with a fresh battery (when disarmed)'],
    ['Space', 'Pause / resume'],
  ]],
  ['Flight modes', MODES.map((m) => [MODE_INFO[m].key, `${MODE_INFO[m].label}: ${MODE_INFO[m].desc}`])],
  ['Views and assessment', [
    ['C', 'Cycle camera: Pilot (VLOS), Chase, FPV, Overhead, Free orbit'],
    ['V', 'Toggle overhead analysis view'],
    ['Mouse wheel', 'Zoom (pilot field of view, chase distance, overhead scale)'],
    ['Z', 'Pilot view auto-zoom on/off'],
    ['F', 'Overhead view: follow drone / fixed'],
    ['O', 'Cycle reference pattern overlay'],
    ['M', 'Mission planner (AUTO waypoint missions)'],
    ['T', 'Clear flight path trail'],
    ['Y', 'Show / hide trail'],
    ['P', 'Capture current view (PNG)'],
    ['Shift + P', 'Capture overhead trail for assessment (PNG)'],
    ['N', 'Cycle day / dusk / night'],
    ['J', 'Cycle weather: clear, overcast, fog, rain'],
    ['L', 'Choose scene (training ground, city, forest, farmland, solar and substation)'],
    ['G', 'Payload camera: off, visible, thermal, night vision'],
    ['[ / ]', 'Payload camera tilt down / up'],
    ['- / =', 'Payload camera zoom out / in'],
    ['B', 'Obstacle braking in Loiter on / off'],
    ['K', 'Sound on / off'],
    ['U', 'Hide / show panels'],
    ['H or F1', 'This help'],
  ]],
];

export function helpHtml() {
  const tables = KEYS.map(([title, rows]) => `
    <section><h3>${title}</h3><table>${rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table></section>`).join('');
  return `
    <div class="help-cols">${tables}</div>
    <section>
      <h3>Safety logic</h3>
      <ul>
        <li><b>Pre-arm checks</b>: throttle low, airframe level, GPS fix for Loiter, battery above ${FC_PARAMS.battLowPct}%, inside the geofence, not crashed. Failures are listed in the message log.</li>
        <li><b>Arming</b> sets the home position and heading. Motors spin at idle when armed.</li>
        <li><b>Auto-disarm</b> after ${FC_PARAMS.disarmDelay} s on the ground with throttle low. RTL and Land disarm automatically on touchdown.</li>
        <li><b>Disarm in flight</b> is refused; only the emergency stop cuts the motors in the air.</li>
        <li><b>Failsafes</b>: battery low (${FC_PARAMS.battLowPct}%) triggers RTL, critical (${FC_PARAMS.battCritPct}%) triggers Land. Controller loss triggers RTL (or Land near home). A geofence breach triggers RTL.</li>
        <li><b>Crash detection</b>: hard touchdowns (over ~3 m/s), ground strikes, tip-overs and collisions with trees, buildings or masts end the flight. Press R to reset.</li>
      </ul>
      <h3>RTL behaviour</h3>
      <p>Climb to the RTL altitude (or hold the current height if higher), turn and fly home at ${FC_PARAMS.rtlSpeed} m/s, loiter ${FC_PARAMS.rtlLoiterTime} s over the pad while restoring the take-off heading, descend at ${FC_PARAMS.landSpeedHigh} m/s to ${FC_PARAMS.landAltLow} m, then ${FC_PARAMS.landSpeed} m/s to touchdown and disarm. Within ${FC_PARAMS.rtlConeDist} m of home it descends without climbing.</p>
      <h3>AUTO missions</h3>
      <p>Open the <b>Mission planner</b> (M). Click the map to add waypoints and drag them to move; set height, speed and hold time for each item, or start from a template (circle, square, figure-of-eight) or a survey grid dragged over the field. Check the warnings (geofence, obstacles, missing RTL), then <b>Upload to drone</b>. The path appears in 3D as a dashed line with numbered markers.</p>
      <p>As in ArduPilot, the drone will not arm in Auto: arm in <b>Loiter</b>, select <b>Auto (7)</b> and raise the throttle to start the takeoff, or take off first and select Auto in the air. A waypoint counts as reached within ${FC_PARAMS.wpRadius} m; the nose turns toward the next waypoint. Select any other mode to take over; selecting Auto again resumes at the same item. Low battery, a fence breach or a lost controller switch to RTL as in every other mode.</p>
      <h3>Using a USB RC transmitter or joystick</h3>
      <p>Put the transmitter in USB joystick (HID) mode, plug it in and open <b>Controller</b>. Run the calibration wizard once; the mapping is saved per controller. Optional switches: 3-position flight mode switch, arm switch and RTL switch.</p>
      <h3>Assessment workflow</h3>
      <p>Clear the trail (T), fly the manoeuvre, select the matching reference pattern in the Trail &amp; Assessment panel to see live RMS error, height stability and coverage, then press <b>Capture overhead trail</b> to save a documented PNG with registration number, trainee, instructor and statistics.</p>
    </section>`;
}
