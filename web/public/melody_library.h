#pragma once

#include <Arduino.h>

// Monophonic melody library for passive buzzers.
// Most hooks are shortened to the most recognizable phrase so they survive
// the limited range and articulation of a small buzzer.

namespace MelodyLibrary {

struct MelodyInfo {
  const char* key;
  const char* title;
  const char* source;
  const int16_t* notes;
  const uint16_t* durations;
  uint8_t length;
  uint8_t defaultRepeats;
};

template <size_t N>
constexpr uint8_t melodyLen(const int16_t (&)[N]) {
  return static_cast<uint8_t>(N);
}

constexpr int16_t REST = 0;

// Notes used by the library.
constexpr int16_t C3  = 131;
constexpr int16_t Cs3 = 139;
constexpr int16_t D3  = 147;
constexpr int16_t Ds3 = 156;
constexpr int16_t E3  = 165;
constexpr int16_t F3  = 175;
constexpr int16_t Fs3 = 185;
constexpr int16_t G3  = 196;
constexpr int16_t Gs3 = 208;
constexpr int16_t A3  = 220;
constexpr int16_t As3 = 233;
constexpr int16_t B3  = 247;
constexpr int16_t C4  = 262;
constexpr int16_t Cs4 = 277;
constexpr int16_t D4  = 294;
constexpr int16_t Ds4 = 311;
constexpr int16_t E4  = 330;
constexpr int16_t F4  = 349;
constexpr int16_t Fs4 = 370;
constexpr int16_t G4  = 392;
constexpr int16_t Gs4 = 415;
constexpr int16_t A4  = 440;
constexpr int16_t As4 = 466;
constexpr int16_t B4  = 494;
constexpr int16_t C5  = 523;
constexpr int16_t Cs5 = 554;
constexpr int16_t D5  = 587;
constexpr int16_t Ds5 = 622;
constexpr int16_t E5  = 659;
constexpr int16_t F5  = 698;
constexpr int16_t Fs5 = 740;
constexpr int16_t G5  = 784;
constexpr int16_t Gs5 = 831;
constexpr int16_t A5  = 880;
constexpr int16_t As5 = 932;
constexpr int16_t B5  = 988;
constexpr int16_t C6  = 1047;
constexpr int16_t Cs6 = 1109;
constexpr int16_t D6  = 1175;
constexpr int16_t Ds6 = 1245;
constexpr int16_t E6  = 1319;
constexpr int16_t F6  = 1397;
constexpr int16_t Fs6 = 1480;
constexpr int16_t G6  = 1568;

#define ML_WHOLE(bpm)      (240000U / (bpm))
#define ML_HALF(bpm)       (120000U / (bpm))
#define ML_DOTTED_Q(bpm)   (90000U / (bpm))
#define ML_QUARTER(bpm)    (60000U / (bpm))
#define ML_TRIPLET_Q(bpm)  (40000U / (bpm))
#define ML_EIGHTH(bpm)     (30000U / (bpm))
#define ML_SIXTEENTH(bpm)  (15000U / (bpm))
#define ML_DOTTED_E(bpm)   (45000U / (bpm))

// Songs

static const int16_t MARIO_N[] = {
  E5, E5, REST, E5, REST, C5, E5, REST, G5, REST, G4
};
static const uint16_t MARIO_D[] = {
  ML_EIGHTH(200), ML_EIGHTH(200), ML_EIGHTH(200), ML_EIGHTH(200),
  ML_EIGHTH(200), ML_EIGHTH(200), ML_QUARTER(200), ML_EIGHTH(200),
  ML_QUARTER(200), ML_QUARTER(200), ML_HALF(200)
};

static const int16_t IMPERIAL_N[] = {
  G4, G4, G4, Ds4, REST, As4, G4, Ds4, REST, As4, G4
};
static const uint16_t IMPERIAL_D[] = {
  ML_QUARTER(104), ML_QUARTER(104), ML_QUARTER(104), ML_DOTTED_E(104),
  ML_SIXTEENTH(104), ML_EIGHTH(104), ML_QUARTER(104), ML_DOTTED_E(104),
  ML_SIXTEENTH(104), ML_EIGHTH(104), ML_HALF(104)
};

static const int16_t UNDER_PRESSURE_N[] = {
  D4, D4, D4, D4, D4, REST, D4, D4, REST, D4, D4, D4, D4, A4, G4
};
static const uint16_t UNDER_PRESSURE_D[] = {
  ML_EIGHTH(148), ML_EIGHTH(148), ML_EIGHTH(148), ML_SIXTEENTH(148),
  ML_SIXTEENTH(148), ML_EIGHTH(148), ML_EIGHTH(148), ML_EIGHTH(148),
  ML_EIGHTH(148), ML_EIGHTH(148), ML_EIGHTH(148), ML_SIXTEENTH(148),
  ML_SIXTEENTH(148), ML_QUARTER(148), ML_HALF(148)
};

static const int16_t GHOSTBUSTERS_N[] = {
  E5, REST, G5, REST, A5, REST, G5, E5, REST, C5, REST, E5
};
static const uint16_t GHOSTBUSTERS_D[] = {
  ML_QUARTER(116), ML_SIXTEENTH(116), ML_QUARTER(116), ML_SIXTEENTH(116),
  ML_QUARTER(116), ML_SIXTEENTH(116), ML_EIGHTH(116), ML_QUARTER(116),
  ML_EIGHTH(116), ML_QUARTER(116), ML_EIGHTH(116), ML_HALF(116)
};

static const int16_t DONT_STOP_BELIEVIN_N[] = {
  B4, B4, Cs5, E5, REST, B4, A4, Fs4, REST, B4, B4, Cs5, E5, Fs5, E5, Cs5, B4
};
static const uint16_t DONT_STOP_BELIEVIN_D[] = {
  ML_EIGHTH(118), ML_EIGHTH(118), ML_QUARTER(118), ML_QUARTER(118),
  ML_EIGHTH(118), ML_EIGHTH(118), ML_QUARTER(118), ML_QUARTER(118),
  ML_EIGHTH(118), ML_EIGHTH(118), ML_EIGHTH(118), ML_QUARTER(118),
  ML_EIGHTH(118), ML_EIGHTH(118), ML_EIGHTH(118), ML_EIGHTH(118),
  ML_HALF(118)
};

static const int16_t EYE_OF_THE_TIGER_N[] = {
  REST, E4, G4, REST, A4, REST, G4, E4, REST, E4, G4, A4, G4
};
static const uint16_t EYE_OF_THE_TIGER_D[] = {
  ML_EIGHTH(109), ML_SIXTEENTH(109), ML_SIXTEENTH(109), ML_EIGHTH(109),
  ML_SIXTEENTH(109), ML_EIGHTH(109), ML_SIXTEENTH(109), ML_EIGHTH(109),
  ML_QUARTER(109), ML_SIXTEENTH(109), ML_SIXTEENTH(109), ML_QUARTER(109),
  ML_HALF(109)
};

static const int16_t BEAT_IT_N[] = {
  E5, D5, E5, REST, E5, D5, E5, G5, E5, D5, REST, E5
};
static const uint16_t BEAT_IT_D[] = {
  ML_SIXTEENTH(138), ML_SIXTEENTH(138), ML_QUARTER(138), ML_SIXTEENTH(138),
  ML_SIXTEENTH(138), ML_SIXTEENTH(138), ML_EIGHTH(138), ML_QUARTER(138),
  ML_EIGHTH(138), ML_EIGHTH(138), ML_EIGHTH(138), ML_HALF(138)
};

static const int16_t THRILLER_N[] = {
  Cs5, REST, Cs5, REST, Cs5, REST, B4, A4, REST, Fs4, A4, B4
};
static const uint16_t THRILLER_D[] = {
  ML_EIGHTH(118), ML_SIXTEENTH(118), ML_EIGHTH(118), ML_SIXTEENTH(118),
  ML_EIGHTH(118), ML_SIXTEENTH(118), ML_EIGHTH(118), ML_QUARTER(118),
  ML_EIGHTH(118), ML_EIGHTH(118), ML_EIGHTH(118), ML_HALF(118)
};

static const int16_t NOKIA_N[] = {
  E5, D5, Fs4, Gs4, Cs5, B4, D4, E4, B4, A4, Cs4, E4, A4
};
static const uint16_t NOKIA_D[] = {
  ML_EIGHTH(140), ML_EIGHTH(140), ML_QUARTER(140), ML_QUARTER(140),
  ML_EIGHTH(140), ML_EIGHTH(140), ML_QUARTER(140), ML_QUARTER(140),
  ML_EIGHTH(140), ML_EIGHTH(140), ML_QUARTER(140), ML_QUARTER(140),
  ML_HALF(140)
};

static const int16_t TAINTED_LOVE_N[] = {
  C5, C5, C5, REST, As4, C5, REST, G5, F5, C5
};
static const uint16_t TAINTED_LOVE_D[] = {
  ML_EIGHTH(155), ML_SIXTEENTH(155), ML_EIGHTH(155), ML_SIXTEENTH(155),
  ML_QUARTER(155), ML_QUARTER(155), ML_EIGHTH(155), ML_QUARTER(155),
  ML_QUARTER(155), ML_HALF(155)
};

static const int16_t HEDWIG_N[] = {
  B4, E5, G5, Fs5, E5, B5, REST, A5, REST, Fs5, REST, E5, G5, Fs5, Ds5, F5, B4
};
static const uint16_t HEDWIG_D[] = {
  ML_QUARTER(78), ML_DOTTED_Q(78), ML_EIGHTH(78), ML_QUARTER(78),
  ML_HALF(78), ML_QUARTER(78), ML_QUARTER(78), ML_DOTTED_Q(78),
  ML_QUARTER(78), ML_DOTTED_Q(78), ML_QUARTER(78), ML_DOTTED_Q(78),
  ML_EIGHTH(78), ML_QUARTER(78), ML_HALF(78), ML_EIGHTH(78), ML_WHOLE(78)
};

static const int16_t JURASSIC_PARK_N[] = {
  B4, E5, G5, E5, B4, A4, G4, E4
};
static const uint16_t JURASSIC_PARK_D[] = {
  ML_QUARTER(84), ML_QUARTER(84), ML_QUARTER(84), ML_QUARTER(84),
  ML_QUARTER(84), ML_EIGHTH(84), ML_EIGHTH(84), ML_HALF(84)
};

static const int16_t HARRY_POTTER_N[] = {
  B4, E5, G5, Fs5, E5, B4, A4, G4
};
static const uint16_t HARRY_POTTER_D[] = {
  ML_QUARTER(80), ML_DOTTED_Q(80), ML_EIGHTH(80), ML_QUARTER(80),
  ML_HALF(80), ML_QUARTER(80), ML_QUARTER(80), ML_HALF(80)
};

static const int16_t LORD_OF_THE_RINGS_N[] = {
  G4, D5, E5, G5, A5, G5, E5, D5
};
static const uint16_t LORD_OF_THE_RINGS_D[] = {
  ML_EIGHTH(82), ML_EIGHTH(82), ML_EIGHTH(82), ML_QUARTER(82),
  ML_EIGHTH(82), ML_EIGHTH(82), ML_QUARTER(82), ML_HALF(82)
};

static const int16_t FUNKYTOWN_N[] = {
  C5, C5, G4, A4, C5, A4, G4, E4, G4, A4, C5
};
static const uint16_t FUNKYTOWN_D[] = {
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_HALF(132)
};

static const int16_t FREE_BIRD_N[] = {
  E4, G4, A4, B4, C5, B4, A4, G4, E4, D4, E4, G4
};
static const uint16_t FREE_BIRD_D[] = {
  ML_EIGHTH(116), ML_EIGHTH(116), ML_EIGHTH(116), ML_EIGHTH(116),
  ML_EIGHTH(116), ML_EIGHTH(116), ML_EIGHTH(116), ML_EIGHTH(116),
  ML_EIGHTH(116), ML_EIGHTH(116), ML_EIGHTH(116), ML_HALF(116)
};

static const int16_t JINGLE_BELLS_N[] = {
  E5, E5, E5, E5, E5, E5, E5, G5, C5, D5, E5
};
static const uint16_t JINGLE_BELLS_D[] = {
  ML_EIGHTH(160), ML_EIGHTH(160), ML_EIGHTH(160), ML_EIGHTH(160),
  ML_EIGHTH(160), ML_EIGHTH(160), ML_EIGHTH(160), ML_EIGHTH(160),
  ML_EIGHTH(160), ML_EIGHTH(160), ML_HALF(160)
};

static const int16_t WE_WISH_YOU_N[] = {
  G4, C5, C5, D5, C5, B4, A4, A4, A4, D5, D5, E5, D5, C5
};
static const uint16_t WE_WISH_YOU_D[] = {
  ML_EIGHTH(132), ML_EIGHTH(132), ML_QUARTER(132), ML_QUARTER(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_QUARTER(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_HALF(132)
};

static const int16_t DECK_THE_HALLS_N[] = {
  C5, B4, A4, G4, A4, B4, C5, D5
};
static const uint16_t DECK_THE_HALLS_D[] = {
  ML_EIGHTH(138), ML_EIGHTH(138), ML_EIGHTH(138), ML_EIGHTH(138),
  ML_EIGHTH(138), ML_EIGHTH(138), ML_EIGHTH(138), ML_HALF(138)
};

static const int16_t CAROL_OF_THE_BELLS_N[] = {
  G5, A5, G5, E5, G5, A5, G5, E5, F5, G5, F5, E5
};
static const uint16_t CAROL_OF_THE_BELLS_D[] = {
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_HALF(168)
};

static const int16_t SILENT_NIGHT_N[] = {
  G4, A4, G4, E4, G4, A4, G4, E4, D4, E4, G4, A4
};
static const uint16_t SILENT_NIGHT_D[] = {
  ML_QUARTER(84), ML_EIGHTH(84), ML_EIGHTH(84), ML_QUARTER(84),
  ML_QUARTER(84), ML_EIGHTH(84), ML_EIGHTH(84), ML_QUARTER(84),
  ML_EIGHTH(84), ML_EIGHTH(84), ML_QUARTER(84), ML_HALF(84)
};

static const int16_t MISSION_IMPOSSIBLE_N[] = {
  Ds5, Ds5, REST, Ds5, Ds5, REST, Ds5, Ds5, REST, E5, REST, F5, REST, F5, REST, Fs5, REST, G5
};
static const uint16_t MISSION_IMPOSSIBLE_D[] = {
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_QUARTER(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_QUARTER(168),
  ML_EIGHTH(168), ML_HALF(168)
};

static const int16_t PINK_PANTHER_N[] = {
  Cs5, D5, REST, Ds5, E5, REST, Cs5, D5, REST, E5, REST, Gs5, A5, REST, G5, E5, D5
};
static const uint16_t PINK_PANTHER_D[] = {
  ML_SIXTEENTH(120), ML_QUARTER(120), ML_EIGHTH(120), ML_SIXTEENTH(120),
  ML_QUARTER(120), ML_EIGHTH(120), ML_SIXTEENTH(120), ML_QUARTER(120),
  ML_EIGHTH(120), ML_QUARTER(120), ML_EIGHTH(120), ML_SIXTEENTH(120),
  ML_QUARTER(120), ML_EIGHTH(120), ML_EIGHTH(120), ML_EIGHTH(120),
  ML_HALF(120)
};

static const int16_t GAME_OF_THRONES_N[] = {
  G4, C5, REST, Ds5, F5, G5, C5, REST, Ds5, F5, REST, D5, REST, G4, C5, REST, Ds5, F5
};
static const uint16_t GAME_OF_THRONES_D[] = {
  ML_QUARTER(85), ML_QUARTER(85), ML_SIXTEENTH(85), ML_EIGHTH(85),
  ML_EIGHTH(85), ML_QUARTER(85), ML_QUARTER(85), ML_SIXTEENTH(85),
  ML_EIGHTH(85), ML_QUARTER(85), ML_SIXTEENTH(85), ML_HALF(85),
  ML_QUARTER(85), ML_QUARTER(85), ML_QUARTER(85), ML_SIXTEENTH(85),
  ML_EIGHTH(85), ML_HALF(85)
};

static const int16_t THE_OFFICE_N[] = {
  As5, F5, As5, C6, As5, A5, G5, REST, F5, D5, F5, G5, F5, D5
};
static const uint16_t THE_OFFICE_D[] = {
  ML_SIXTEENTH(168), ML_EIGHTH(168), ML_SIXTEENTH(168), ML_EIGHTH(168),
  ML_SIXTEENTH(168), ML_EIGHTH(168), ML_QUARTER(168), ML_EIGHTH(168),
  ML_SIXTEENTH(168), ML_EIGHTH(168), ML_SIXTEENTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_HALF(168)
};

static const int16_t IM_LOVIN_IT_N[] = {
  F5, A5, REST, As5, REST, A5, F5
};
static const uint16_t IM_LOVIN_IT_D[] = {
  ML_EIGHTH(130), ML_EIGHTH(130), ML_SIXTEENTH(130), ML_QUARTER(130),
  ML_SIXTEENTH(130), ML_QUARTER(130), ML_HALF(130)
};

static const int16_t INTEL_INSIDE_N[] = {
  D5, D5, G5, D5, A5
};
static const uint16_t INTEL_INSIDE_D[] = {
  ML_EIGHTH(106), ML_EIGHTH(106), ML_EIGHTH(106), ML_EIGHTH(106), ML_HALF(106)
};

static const int16_t PIRATES_N[] = {
  D4, REST, D4, D4, D4, E4, F4, REST, F4, F4, G4, E4, REST, E4, D4, C4, D4
};
static const uint16_t PIRATES_D[] = {
  ML_EIGHTH(120), ML_SIXTEENTH(120), ML_EIGHTH(120), ML_SIXTEENTH(120),
  ML_EIGHTH(120), ML_SIXTEENTH(120), ML_QUARTER(120), ML_SIXTEENTH(120),
  ML_EIGHTH(120), ML_SIXTEENTH(120), ML_EIGHTH(120), ML_QUARTER(120),
  ML_SIXTEENTH(120), ML_EIGHTH(120), ML_SIXTEENTH(120), ML_EIGHTH(120),
  ML_HALF(120)
};

static const int16_t STRANGER_THINGS_N[] = {
  C4, E4, G4, B4, C5, B4, G4, E4, C4, E4, G4, B4, C5
};
static const uint16_t STRANGER_THINGS_D[] = {
  ML_EIGHTH(80), ML_EIGHTH(80), ML_EIGHTH(80), ML_EIGHTH(80), ML_QUARTER(80),
  ML_EIGHTH(80), ML_EIGHTH(80), ML_EIGHTH(80), ML_EIGHTH(80), ML_EIGHTH(80),
  ML_EIGHTH(80), ML_EIGHTH(80), ML_HALF(80)
};

static const int16_t SIMPSONS_N[] = {
  C5, E5, Fs5, A5, REST, G5, E5, C5, REST, A4, Fs4, Fs4, Fs4, REST, G4, REST, C4
};
static const uint16_t SIMPSONS_D[] = {
  ML_QUARTER(172), ML_QUARTER(172), ML_QUARTER(172), ML_HALF(172),
  ML_EIGHTH(172), ML_QUARTER(172), ML_QUARTER(172), ML_QUARTER(172),
  ML_EIGHTH(172), ML_EIGHTH(172), ML_SIXTEENTH(172), ML_SIXTEENTH(172),
  ML_QUARTER(172), ML_EIGHTH(172), ML_QUARTER(172), ML_EIGHTH(172),
  ML_WHOLE(172)
};

static const int16_t JAWS_N[] = {
  E3, F3, E3, F3, E3, F3, E3, F3
};
static const uint16_t JAWS_D[] = {
  ML_QUARTER(96), ML_QUARTER(96), ML_QUARTER(108), ML_QUARTER(108),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(160), ML_HALF(160)
};

static const int16_t SHAVE_AND_A_HAIRCUT_N[] = {
  C4, G4, G4, A4, G4, REST, B4, C5
};
static const uint16_t SHAVE_AND_A_HAIRCUT_D[] = {
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_QUARTER(132),
  ML_QUARTER(132), ML_QUARTER(132), ML_EIGHTH(132), ML_HALF(132)
};

static const int16_t CHARGE_N[] = {
  C4, E4, G4, C5
};
static const uint16_t CHARGE_D[] = {
  ML_EIGHTH(176), ML_EIGHTH(176), ML_EIGHTH(176), ML_HALF(176)
};

static const int16_t JEOPARDY_N[] = {
  C4, F4, C4, F3, C4, F4, C4, REST, C4, F4, A4, As4, A4, G4, F4, C4
};
static const uint16_t JEOPARDY_D[] = {
  ML_QUARTER(132), ML_QUARTER(132), ML_QUARTER(132), ML_QUARTER(132),
  ML_QUARTER(132), ML_QUARTER(132), ML_HALF(132), ML_QUARTER(132),
  ML_QUARTER(132), ML_QUARTER(132), ML_QUARTER(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_QUARTER(132), ML_QUARTER(132), ML_HALF(132)
};

static const int16_t FUR_ELISE_N[] = {
  E5, Ds5, E5, Ds5, E5, B4, D5, C5, A4, REST, C4, E4, A4, B4, REST, E4, Gs4, B4, C5
};
static const uint16_t FUR_ELISE_D[] = {
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_QUARTER(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_QUARTER(132), ML_EIGHTH(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_HALF(132)
};

static const int16_t BEETHOVEN_FIFTH_N[] = {
  G4, G4, G4, Ds4, F4, F4, F4, D4
};
static const uint16_t BEETHOVEN_FIFTH_D[] = {
  ML_EIGHTH(108), ML_EIGHTH(108), ML_EIGHTH(108), ML_DOTTED_Q(108),
  ML_EIGHTH(108), ML_EIGHTH(108), ML_EIGHTH(108), ML_DOTTED_Q(108)
};

static const int16_t HAPPY_BIRTHDAY_N[] = {
  C4, C4, D4, C4, F4, E4, C4, C4, D4, C4, G4, F4
};
static const uint16_t HAPPY_BIRTHDAY_D[] = {
  ML_EIGHTH(120), ML_EIGHTH(120), ML_QUARTER(120), ML_QUARTER(120),
  ML_QUARTER(120), ML_HALF(120), ML_EIGHTH(120), ML_EIGHTH(120),
  ML_QUARTER(120), ML_QUARTER(120), ML_QUARTER(120), ML_HALF(120)
};

static const int16_t TETRIS_N[] = {
  E5, B4, C5, D5, C5, B4, A4, A4, C5, E5, D5, C5, B4, C5, D5, E5
};
static const uint16_t TETRIS_D[] = {
  ML_QUARTER(144), ML_EIGHTH(144), ML_EIGHTH(144), ML_QUARTER(144),
  ML_EIGHTH(144), ML_EIGHTH(144), ML_QUARTER(144), ML_EIGHTH(144),
  ML_EIGHTH(144), ML_QUARTER(144), ML_EIGHTH(144), ML_EIGHTH(144),
  ML_DOTTED_Q(144), ML_EIGHTH(144), ML_QUARTER(144), ML_HALF(144)
};

static const int16_t ZELDA_SECRET_N[] = {
  G4, Fs4, Ds4, A3, Gs3, E4, Gs4, C5
};
static const uint16_t ZELDA_SECRET_D[] = {
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_HALF(168)
};

static const int16_t PACMAN_START_N[] = {
  B4, B5, Fs5, Ds5, B5, Fs5, Ds5, C5, C6, G5, E5, C6, G5, E5
};
static const uint16_t PACMAN_START_D[] = {
  ML_EIGHTH(176), ML_EIGHTH(176), ML_EIGHTH(176), ML_EIGHTH(176),
  ML_SIXTEENTH(176), ML_SIXTEENTH(176), ML_QUARTER(176), ML_EIGHTH(176),
  ML_EIGHTH(176), ML_EIGHTH(176), ML_EIGHTH(176), ML_SIXTEENTH(176),
  ML_SIXTEENTH(176), ML_QUARTER(176)
};

static const int16_t LOONEY_TUNES_N[] = {
  C5, A4, F4, G4, A4, C5, A4, C5, D5, C5, A4, G4, F4
};
static const uint16_t LOONEY_TUNES_D[] = {
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_QUARTER(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_EIGHTH(168), ML_QUARTER(168), ML_EIGHTH(168), ML_EIGHTH(168),
  ML_HALF(168)
};

static const int16_t ADDAMS_FAMILY_N[] = {
  A4, C5, F5, A5, REST, A5, REST, A5, G5, F5, E5, D5
};
static const uint16_t ADDAMS_FAMILY_D[] = {
  ML_EIGHTH(140), ML_EIGHTH(140), ML_EIGHTH(140), ML_QUARTER(140),
  ML_EIGHTH(140), ML_EIGHTH(140), ML_EIGHTH(140), ML_EIGHTH(140),
  ML_EIGHTH(140), ML_EIGHTH(140), ML_EIGHTH(140), ML_HALF(140)
};

static const int16_t LAW_AND_ORDER_N[] = {
  G4, REST, C5
};
static const uint16_t LAW_AND_ORDER_D[] = {
  180, 70, 320
};

static const int16_t TWILIGHT_ZONE_N[] = {
  C5, F5, C5, B4, C5, F5, C5, B4
};
static const uint16_t TWILIGHT_ZONE_D[] = {
  ML_EIGHTH(152), ML_EIGHTH(152), ML_EIGHTH(152), ML_EIGHTH(152),
  ML_EIGHTH(152), ML_EIGHTH(152), ML_EIGHTH(152), ML_HALF(152)
};

static const int16_t SEINFELD_STAB_N[] = {
  C4, E4, G4, A4, G4, E4
};
static const uint16_t SEINFELD_STAB_D[] = {
  ML_SIXTEENTH(176), ML_SIXTEENTH(176), ML_EIGHTH(176),
  ML_EIGHTH(176), ML_SIXTEENTH(176), ML_QUARTER(176)
};

static const int16_t XFILES_N[] = {
  Fs4, A4, E5, D5, A4, E5, D5, A4
};
static const uint16_t XFILES_D[] = {
  ML_QUARTER(96), ML_QUARTER(96), ML_HALF(96), ML_QUARTER(96),
  ML_QUARTER(96), ML_HALF(96), ML_QUARTER(96), ML_HALF(96)
};

static const int16_t FRESH_PRINCE_N[] = {
  F4, A4, C5, REST, C5, A4, F4, G4, A4
};
static const uint16_t FRESH_PRINCE_D[] = {
  ML_EIGHTH(132), ML_EIGHTH(132), ML_QUARTER(132), ML_EIGHTH(132),
  ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_EIGHTH(132), ML_HALF(132)
};

static const int16_t WII_MII_N[] = {
  Fs4, A4, Cs5, A4, Fs4, D4, D4, D4
};
static const uint16_t WII_MII_D[] = {
  ML_EIGHTH(114), ML_EIGHTH(114), ML_QUARTER(114), ML_EIGHTH(114),
  ML_EIGHTH(114), ML_EIGHTH(114), ML_EIGHTH(114), ML_HALF(114)
};

static const int16_t WINDOWS_XP_N[] = {
  G4, C5, D5, G5
};
static const uint16_t WINDOWS_XP_D[] = {
  ML_EIGHTH(92), ML_EIGHTH(92), ML_QUARTER(92), ML_HALF(92)
};

static const int16_t NBC_CHIMES_N[] = {
  G4, E4, C4
};
static const uint16_t NBC_CHIMES_D[] = {
  ML_QUARTER(108), ML_QUARTER(108), ML_HALF(108)
};

static const int16_t TACO_BELL_N[] = {
  B4, Fs5, E5, B4
};
static const uint16_t TACO_BELL_D[] = {
  ML_EIGHTH(124), ML_EIGHTH(124), ML_EIGHTH(124), ML_HALF(124)
};

static const int16_t AOL_YOUGOTMAIL_N[] = {
  C4, E4, G4
};
static const uint16_t AOL_YOUGOTMAIL_D[] = {
  ML_EIGHTH(120), ML_EIGHTH(120), ML_HALF(120)
};

static const int16_t VERIZON_N[] = {
  E5, C5, A4
};
static const uint16_t VERIZON_D[] = {
  ML_EIGHTH(126), ML_EIGHTH(126), ML_HALF(126)
};

static const int16_t ESPN_N[] = {
  C5, A4, C5, E5, C5
};
static const uint16_t ESPN_D[] = {
  ML_SIXTEENTH(160), ML_SIXTEENTH(160), ML_EIGHTH(160), ML_EIGHTH(160), ML_HALF(160)
};

static const int16_t NETFLIX_TA_DUM_N[] = {
  G4, C5
};
static const uint16_t NETFLIX_TA_DUM_D[] = {
  180, 420
};

static const int16_t PLAYSTATION_BOOT_N[] = {
  E4, E5, A4, B4, E5
};
static const uint16_t PLAYSTATION_BOOT_D[] = {
  ML_EIGHTH(90), ML_QUARTER(90), ML_EIGHTH(90), ML_EIGHTH(90), ML_HALF(90)
};

static const int16_t PRICE_IS_RIGHT_N[] = {
  G4, C5, E5, G5, E5, C5
};
static const uint16_t PRICE_IS_RIGHT_D[] = {
  ML_EIGHTH(172), ML_EIGHTH(172), ML_EIGHTH(172), ML_QUARTER(172),
  ML_EIGHTH(172), ML_HALF(172)
};

static const int16_t FOX_FANFARE_N[] = {
  C5, G5, C6, G5, C6
};
static const uint16_t FOX_FANFARE_D[] = {
  ML_QUARTER(112), ML_QUARTER(112), ML_QUARTER(112), ML_QUARTER(112), ML_HALF(112)
};

static const int16_t MARIO_POWERUP_N[] = {
  G4, B4, D5, G5
};
static const uint16_t MARIO_POWERUP_D[] = {
  ML_SIXTEENTH(200), ML_SIXTEENTH(200), ML_SIXTEENTH(200), ML_QUARTER(200)
};

static const int16_t SONIC_RING_N[] = {
  E6, G6, C6
};
static const uint16_t SONIC_RING_D[] = {
  ML_SIXTEENTH(220), ML_SIXTEENTH(220), ML_EIGHTH(220)
};

static const int16_t FAMILY_FEUD_N[] = {
  C4, E4, G4, C5, REST, C5
};
static const uint16_t FAMILY_FEUD_D[] = {
  ML_SIXTEENTH(188), ML_SIXTEENTH(188), ML_SIXTEENTH(188), ML_QUARTER(188),
  ML_EIGHTH(188), ML_HALF(188)
};

static const int16_t CNN_BREAKING_N[] = {
  C5, E5, G5, E5
};
static const uint16_t CNN_BREAKING_D[] = {
  ML_EIGHTH(168), ML_EIGHTH(168), ML_EIGHTH(168), ML_HALF(168)
};

static const int16_t THX_SWEEP_N[] = {
  C4, G4, C5, G5, C6
};
static const uint16_t THX_SWEEP_D[] = {
  ML_EIGHTH(72), ML_EIGHTH(72), ML_QUARTER(72), ML_QUARTER(72), ML_HALF(72)
};

static const int16_t BATMAN_66_N[] = {
  D4, REST, D4, REST, D4, G4, A4, D5
};
static const uint16_t BATMAN_66_D[] = {
  ML_EIGHTH(172), ML_EIGHTH(172), ML_EIGHTH(172), ML_EIGHTH(172),
  ML_EIGHTH(172), ML_EIGHTH(172), ML_EIGHTH(172), ML_HALF(172)
};

static const int16_t MUNSTERS_N[] = {
  E4, G4, A4, B4, A4, G4, E4
};
static const uint16_t MUNSTERS_D[] = {
  ML_EIGHTH(142), ML_EIGHTH(142), ML_EIGHTH(142), ML_QUARTER(142),
  ML_EIGHTH(142), ML_EIGHTH(142), ML_HALF(142)
};

static const int16_t DRAGNET_N[] = {
  C4, Cs4, D4
};
static const uint16_t DRAGNET_D[] = {
  ML_QUARTER(88), ML_QUARTER(88), ML_HALF(88)
};

static const int16_t BRADY_BUNCH_N[] = {
  C4, E4, G4, A4, G4, E4, D4, F4, A4
};
static const uint16_t BRADY_BUNCH_D[] = {
  ML_EIGHTH(136), ML_EIGHTH(136), ML_EIGHTH(136), ML_QUARTER(136),
  ML_EIGHTH(136), ML_EIGHTH(136), ML_EIGHTH(136), ML_EIGHTH(136), ML_HALF(136)
};

static const int16_t JEOPARDY_FINAL_N[] = {
  C4, F4, A4, G4, F4, C4, F4, C5
};
static const uint16_t JEOPARDY_FINAL_D[] = {
  ML_QUARTER(104), ML_QUARTER(104), ML_QUARTER(104), ML_QUARTER(104),
  ML_QUARTER(104), ML_QUARTER(104), ML_QUARTER(104), ML_HALF(104)
};

static const int16_t MARIO_1UP_N[] = {
  E5, G5, E6, C6, D6, G6
};
static const uint16_t MARIO_1UP_D[] = {
  ML_SIXTEENTH(188), ML_SIXTEENTH(188), ML_SIXTEENTH(188),
  ML_SIXTEENTH(188), ML_SIXTEENTH(188), ML_QUARTER(188)
};

static const int16_t ZELDA_ITEM_N[] = {
  G4, A4, B4, C5, D5
};
static const uint16_t ZELDA_ITEM_D[] = {
  ML_EIGHTH(150), ML_EIGHTH(150), ML_EIGHTH(150), ML_EIGHTH(150), ML_HALF(150)
};

static const int16_t STREET_FIGHTER_N[] = {
  C5, C5, D5, G4, REST, G4, A4, C5
};
static const uint16_t STREET_FIGHTER_D[] = {
  ML_EIGHTH(156), ML_EIGHTH(156), ML_QUARTER(156), ML_EIGHTH(156),
  ML_EIGHTH(156), ML_EIGHTH(156), ML_EIGHTH(156), ML_HALF(156)
};

// Alerts / system melodies

static const int16_t CALIBRATION_FANFARE_N[] = {
  C5, E5, G5, REST, C6, REST, G5, C6, REST, E5, G5, C6, E5, G5, C6, REST, C6
};
static const uint16_t CALIBRATION_FANFARE_D[] = {
  ML_EIGHTH(160), ML_EIGHTH(160), ML_EIGHTH(160), ML_SIXTEENTH(160),
  ML_QUARTER(160), ML_SIXTEENTH(160), ML_EIGHTH(160), ML_DOTTED_Q(160),
  ML_SIXTEENTH(160), ML_SIXTEENTH(160), ML_SIXTEENTH(160), ML_SIXTEENTH(160),
  ML_SIXTEENTH(160), ML_SIXTEENTH(160), ML_EIGHTH(160), ML_SIXTEENTH(160),
  ML_HALF(160)
};

static const int16_t SMOKE_ALERT_N[] = {
  A5, REST, A5, REST, A5
};
static const uint16_t SMOKE_ALERT_D[] = {
  150, 80, 150, 80, 250
};

static const int16_t WESTMINSTER_N[] = {
  E5, Gs5, Fs5, B4, REST, B4, Fs5, Gs5, E5
};
static const uint16_t WESTMINSTER_D[] = {
  ML_QUARTER(72), ML_QUARTER(72), ML_QUARTER(72), ML_HALF(72), ML_QUARTER(72),
  ML_QUARTER(72), ML_QUARTER(72), ML_QUARTER(72), ML_WHOLE(72)
};

static const MelodyInfo SONGS[] = {
  { "mario", "Super Mario Bros", "Nintendo", MARIO_N, MARIO_D, melodyLen(MARIO_N), 1 },
  { "imperial_march", "Imperial March", "John Williams", IMPERIAL_N, IMPERIAL_D, melodyLen(IMPERIAL_N), 1 },
  { "under_pressure", "Under Pressure", "Queen / Bowie", UNDER_PRESSURE_N, UNDER_PRESSURE_D, melodyLen(UNDER_PRESSURE_N), 1 },
  { "ghostbusters", "Ghostbusters", "Ray Parker Jr.", GHOSTBUSTERS_N, GHOSTBUSTERS_D, melodyLen(GHOSTBUSTERS_N), 1 },
  { "dont_stop_believin", "Don't Stop Believin'", "Journey", DONT_STOP_BELIEVIN_N, DONT_STOP_BELIEVIN_D, melodyLen(DONT_STOP_BELIEVIN_N), 1 },
  { "eye_of_the_tiger", "Eye of the Tiger", "Survivor", EYE_OF_THE_TIGER_N, EYE_OF_THE_TIGER_D, melodyLen(EYE_OF_THE_TIGER_N), 1 },
  { "beat_it", "Beat It", "Michael Jackson", BEAT_IT_N, BEAT_IT_D, melodyLen(BEAT_IT_N), 1 },
  { "thriller", "Thriller", "Michael Jackson", THRILLER_N, THRILLER_D, melodyLen(THRILLER_N), 1 },
  { "nokia", "Nokia Ringtone", "Gran Vals", NOKIA_N, NOKIA_D, melodyLen(NOKIA_N), 1 },
  { "tainted_love", "Tainted Love", "Soft Cell", TAINTED_LOVE_N, TAINTED_LOVE_D, melodyLen(TAINTED_LOVE_N), 1 },
  { "hedwig", "Hedwig's Theme", "John Williams", HEDWIG_N, HEDWIG_D, melodyLen(HEDWIG_N), 1 },
  { "jurassic_park", "Jurassic Park", "John Williams", JURASSIC_PARK_N, JURASSIC_PARK_D, melodyLen(JURASSIC_PARK_N), 1 },
  { "harry_potter", "Harry Potter", "John Williams", HARRY_POTTER_N, HARRY_POTTER_D, melodyLen(HARRY_POTTER_N), 1 },
  { "lord_of_the_rings", "Lord of the Rings", "Howard Shore", LORD_OF_THE_RINGS_N, LORD_OF_THE_RINGS_D, melodyLen(LORD_OF_THE_RINGS_N), 1 },
  { "funkytown", "Funkytown", "Lipps Inc.", FUNKYTOWN_N, FUNKYTOWN_D, melodyLen(FUNKYTOWN_N), 1 },
  { "free_bird", "Free Bird", "Lynyrd Skynyrd", FREE_BIRD_N, FREE_BIRD_D, melodyLen(FREE_BIRD_N), 1 },
  { "jingle_bells", "Jingle Bells", "Traditional", JINGLE_BELLS_N, JINGLE_BELLS_D, melodyLen(JINGLE_BELLS_N), 1 },
  { "we_wish_you", "We Wish You a Merry Christmas", "Traditional", WE_WISH_YOU_N, WE_WISH_YOU_D, melodyLen(WE_WISH_YOU_N), 1 },
  { "deck_the_halls", "Deck the Halls", "Traditional", DECK_THE_HALLS_N, DECK_THE_HALLS_D, melodyLen(DECK_THE_HALLS_N), 1 },
  { "carol_of_the_bells", "Carol of the Bells", "Traditional", CAROL_OF_THE_BELLS_N, CAROL_OF_THE_BELLS_D, melodyLen(CAROL_OF_THE_BELLS_N), 1 },
  { "silent_night", "Silent Night", "Traditional", SILENT_NIGHT_N, SILENT_NIGHT_D, melodyLen(SILENT_NIGHT_N), 1 },
  { "mission_impossible", "Mission Impossible", "Lalo Schifrin", MISSION_IMPOSSIBLE_N, MISSION_IMPOSSIBLE_D, melodyLen(MISSION_IMPOSSIBLE_N), 1 },
  { "pink_panther", "Pink Panther", "Henry Mancini", PINK_PANTHER_N, PINK_PANTHER_D, melodyLen(PINK_PANTHER_N), 1 },
  { "game_of_thrones", "Game of Thrones", "Ramin Djawadi", GAME_OF_THRONES_N, GAME_OF_THRONES_D, melodyLen(GAME_OF_THRONES_N), 1 },
  { "the_office", "The Office", "Jay Ferguson", THE_OFFICE_N, THE_OFFICE_D, melodyLen(THE_OFFICE_N), 1 },
  { "im_lovin_it", "I'm Lovin' It", "McDonald's", IM_LOVIN_IT_N, IM_LOVIN_IT_D, melodyLen(IM_LOVIN_IT_N), 1 },
  { "intel_inside", "Intel Inside", "Intel", INTEL_INSIDE_N, INTEL_INSIDE_D, melodyLen(INTEL_INSIDE_N), 1 },
  { "pirates", "He's a Pirate", "Hans Zimmer", PIRATES_N, PIRATES_D, melodyLen(PIRATES_N), 1 },
  { "stranger_things", "Stranger Things", "Dixon / Stein", STRANGER_THINGS_N, STRANGER_THINGS_D, melodyLen(STRANGER_THINGS_N), 1 },
  { "simpsons", "The Simpsons", "Danny Elfman", SIMPSONS_N, SIMPSONS_D, melodyLen(SIMPSONS_N), 1 },
  { "jaws", "Jaws", "John Williams", JAWS_N, JAWS_D, melodyLen(JAWS_N), 1 },
  { "shave_and_a_haircut", "Shave and a Haircut", "Traditional", SHAVE_AND_A_HAIRCUT_N, SHAVE_AND_A_HAIRCUT_D, melodyLen(SHAVE_AND_A_HAIRCUT_N), 1 },
  { "charge", "Charge!", "Stadium Organ", CHARGE_N, CHARGE_D, melodyLen(CHARGE_N), 1 },
  { "jeopardy", "Jeopardy Think", "Merv Griffin", JEOPARDY_N, JEOPARDY_D, melodyLen(JEOPARDY_N), 1 },
  { "fur_elise", "Fur Elise", "Beethoven", FUR_ELISE_N, FUR_ELISE_D, melodyLen(FUR_ELISE_N), 1 },
  { "beethoven_fifth", "Beethoven's Fifth", "Beethoven", BEETHOVEN_FIFTH_N, BEETHOVEN_FIFTH_D, melodyLen(BEETHOVEN_FIFTH_N), 1 },
  { "happy_birthday", "Happy Birthday", "Traditional", HAPPY_BIRTHDAY_N, HAPPY_BIRTHDAY_D, melodyLen(HAPPY_BIRTHDAY_N), 1 },
  { "tetris", "Tetris Type A", "Korobeiniki", TETRIS_N, TETRIS_D, melodyLen(TETRIS_N), 1 },
  { "zelda_secret", "Zelda Secret", "Nintendo", ZELDA_SECRET_N, ZELDA_SECRET_D, melodyLen(ZELDA_SECRET_N), 1 },
  { "pacman_start", "Pac-Man Start", "Namco", PACMAN_START_N, PACMAN_START_D, melodyLen(PACMAN_START_N), 1 },
  { "looney_tunes", "Looney Tunes", "Warner Bros.", LOONEY_TUNES_N, LOONEY_TUNES_D, melodyLen(LOONEY_TUNES_N), 1 }
};

static const MelodyInfo ICONIC_JINGLES[] = {
  { "addams_family", "Addams Family", "TV Theme", ADDAMS_FAMILY_N, ADDAMS_FAMILY_D, melodyLen(ADDAMS_FAMILY_N), 1 },
  { "law_and_order", "Law & Order Stab", "TV Stinger", LAW_AND_ORDER_N, LAW_AND_ORDER_D, melodyLen(LAW_AND_ORDER_N), 1 },
  { "twilight_zone", "Twilight Zone", "TV Theme", TWILIGHT_ZONE_N, TWILIGHT_ZONE_D, melodyLen(TWILIGHT_ZONE_N), 1 },
  { "seinfeld_stab", "Seinfeld Bass Stab", "TV Theme", SEINFELD_STAB_N, SEINFELD_STAB_D, melodyLen(SEINFELD_STAB_N), 1 },
  { "xfiles", "The X-Files", "TV Theme", XFILES_N, XFILES_D, melodyLen(XFILES_N), 1 },
  { "fresh_prince", "Fresh Prince", "TV Theme", FRESH_PRINCE_N, FRESH_PRINCE_D, melodyLen(FRESH_PRINCE_N), 1 },
  { "wii_mii", "Wii Mii Channel", "Nintendo", WII_MII_N, WII_MII_D, melodyLen(WII_MII_N), 1 },
  { "windows_xp", "Windows XP Startup", "Microsoft", WINDOWS_XP_N, WINDOWS_XP_D, melodyLen(WINDOWS_XP_N), 1 },
  { "nbc_chimes", "NBC Chimes", "Network Jingle", NBC_CHIMES_N, NBC_CHIMES_D, melodyLen(NBC_CHIMES_N), 1 },
  { "taco_bell", "Taco Bell Bong", "Commercial Jingle", TACO_BELL_N, TACO_BELL_D, melodyLen(TACO_BELL_N), 1 },
  { "aol_mail", "You've Got Mail", "AOL", AOL_YOUGOTMAIL_N, AOL_YOUGOTMAIL_D, melodyLen(AOL_YOUGOTMAIL_N), 1 },
  { "verizon", "Verizon Stinger", "Commercial Jingle", VERIZON_N, VERIZON_D, melodyLen(VERIZON_N), 1 },
  { "espn", "ESPN Fanfare", "Sports Jingle", ESPN_N, ESPN_D, melodyLen(ESPN_N), 1 },
  { "netflix", "Netflix Ta-Dum", "Netflix", NETFLIX_TA_DUM_N, NETFLIX_TA_DUM_D, melodyLen(NETFLIX_TA_DUM_N), 1 },
  { "playstation_boot", "PlayStation Boot", "Sony", PLAYSTATION_BOOT_N, PLAYSTATION_BOOT_D, melodyLen(PLAYSTATION_BOOT_N), 1 },
  { "price_is_right", "The Price Is Right", "Game Show", PRICE_IS_RIGHT_N, PRICE_IS_RIGHT_D, melodyLen(PRICE_IS_RIGHT_N), 1 },
  { "fox_fanfare", "20th Century Fox", "Studio Fanfare", FOX_FANFARE_N, FOX_FANFARE_D, melodyLen(FOX_FANFARE_N), 1 },
  { "mario_powerup", "Mario Power-Up", "Nintendo", MARIO_POWERUP_N, MARIO_POWERUP_D, melodyLen(MARIO_POWERUP_N), 1 },
  { "sonic_ring", "Sonic Ring", "Sega", SONIC_RING_N, SONIC_RING_D, melodyLen(SONIC_RING_N), 2 },
  { "family_feud", "Family Feud Sting", "Game Show", FAMILY_FEUD_N, FAMILY_FEUD_D, melodyLen(FAMILY_FEUD_N), 1 },
  { "cnn_breaking", "CNN Breaking News", "News Stinger", CNN_BREAKING_N, CNN_BREAKING_D, melodyLen(CNN_BREAKING_N), 1 },
  { "thx_sweep", "THX-Style Sweep", "Cinematic Stinger", THX_SWEEP_N, THX_SWEEP_D, melodyLen(THX_SWEEP_N), 1 },
  { "batman_66", "Batman '66", "TV Theme", BATMAN_66_N, BATMAN_66_D, melodyLen(BATMAN_66_N), 1 },
  { "munsters", "The Munsters", "TV Theme", MUNSTERS_N, MUNSTERS_D, melodyLen(MUNSTERS_N), 1 },
  { "dragnet", "Dragnet", "TV Theme", DRAGNET_N, DRAGNET_D, melodyLen(DRAGNET_N), 1 },
  { "brady_bunch", "The Brady Bunch", "TV Theme", BRADY_BUNCH_N, BRADY_BUNCH_D, melodyLen(BRADY_BUNCH_N), 1 },
  { "jeopardy_final", "Final Jeopardy", "Game Show", JEOPARDY_FINAL_N, JEOPARDY_FINAL_D, melodyLen(JEOPARDY_FINAL_N), 1 },
  { "mario_1up", "Mario 1-Up", "Nintendo", MARIO_1UP_N, MARIO_1UP_D, melodyLen(MARIO_1UP_N), 1 },
  { "zelda_item", "Zelda Item Get", "Nintendo", ZELDA_ITEM_N, ZELDA_ITEM_D, melodyLen(ZELDA_ITEM_N), 1 },
  { "street_fighter", "Street Fighter Sting", "Capcom", STREET_FIGHTER_N, STREET_FIGHTER_D, melodyLen(STREET_FIGHTER_N), 1 }
};

static const MelodyInfo ALERTS[] = {
  { "calibration_fanfare", "Calibration Fanfare", "System", CALIBRATION_FANFARE_N, CALIBRATION_FANFARE_D, melodyLen(CALIBRATION_FANFARE_N), 1 },
  { "smoke_alert", "Smoke Alert", "System", SMOKE_ALERT_N, SMOKE_ALERT_D, melodyLen(SMOKE_ALERT_N), 1 },
  { "westminster", "Westminster Chime", "Clock Chime", WESTMINSTER_N, WESTMINSTER_D, melodyLen(WESTMINSTER_N), 1 }
};

constexpr size_t SONG_COUNT = sizeof(SONGS) / sizeof(SONGS[0]);
constexpr size_t JINGLE_COUNT = sizeof(ICONIC_JINGLES) / sizeof(ICONIC_JINGLES[0]);
constexpr size_t ALERT_COUNT = sizeof(ALERTS) / sizeof(ALERTS[0]);

}  // namespace MelodyLibrary
