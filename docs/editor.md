# EDITOR: a full-screen BASIC editor for the 48K Spectrum

EDITOR replaces the 48K Spectrum's one-line editor with a full-screen one. The whole screen shows the program as LIST shows it, in a smaller 5x7 font that fits 42 columns and 23 rows, with a status row at the bottom. The cursor goes anywhere on the listing, keywords are typed as words, letter by letter, and a line goes into the program when you press ENTER on it or move off it. A line without a number runs as a command. The program it makes is exactly the one the ROM would have made had you typed the same lines on its own editor, byte for byte: EDITOR is machine code that hands every line to the ROM's own routines to check and store.

EDITOR is on the **Projects** starter cassette. Its source, fully commented Z80 assembly, is [starter/editor.asm](../starter/editor.asm).

## Loading it

Put the Projects cassette in the recorder, wind to EDITOR (click the recorder for its list of parts), and load it as any program: `LOAD ""`. The loader moves RAMTOP down with `CLEAR 53247`, loads the machine code above it (about a minute of tape, or a moment with instant tape loading) and starts EDITOR on an empty program.

EDITOR runs on the 48K, and on the 128K in 48 BASIC (choose 48 BASIC from the 128K menu, or type `USR 0` in 128 BASIC first). It does not work in 128 BASIC, which has a full-screen editor of its own.

Once loaded, EDITOR has three entry points:

| Command | What it does |
| --- | --- |
| `RANDOMIZE USR 53248` | Starts EDITOR again, keeping the program in memory. |
| `RANDOMIZE USR 53251` | Starts EDITOR with NEW, on an empty program (the loader uses this). |
| `RANDOMIZE USR 53254` | Lets go of EDITOR: the ROM's own editor stays from then on, and CLEAR can go above 53247 again. |

To edit a program from a tape, start EDITOR and then load the program with `LOAD ""` typed as a command in EDITOR; when it has loaded, EDITOR lists it.

## The screen

Each line is listed as LIST lists it: the number right-aligned in four columns, keywords in capitals with LIST's spaces around them, and a long line carried on over as many rows as it needs. Below the last line there is always an empty **new line**, where a line typed goes in. After you enter a line, the new line moves to just below it, so that lines typed one after another follow each other.

The bottom row is the status row. It shows the line under the cursor (or *New line*), whether typing inserts (*INS*) or overtypes (*OVR*), and *CAPS*, *GRAPH*, *AUTO* and *EXTEND* while those are on. Messages and reports show there too, until the next key.

The cursor is a blinking inverted cell in insert mode, and a blinking line under the cell in overtype mode.

Characters that are not letters are shown as follows:

* **Block graphics** fill their quarters of the cell.
* **User-defined graphics** are squeezed from 8 columns into 6.
* **Colour controls** written into a line (INK, PAPER, FLASH, BRIGHT, INVERSE, OVER, AT and TAB) show as an inverted letter (`i` `p` `f` `b` `v` `o` `@` `t`), followed by their numbers as inverted digits: a number of 10 or more, such as a row or column of AT, shows as an inverted `?`.

A row has room for 28 different block graphics, user-defined graphics and control cells between them; any more on the same row show as `?`. A row of a line seldom has that many.

## Typing

Keywords are typed as words, as in 128 BASIC: type `print`, `Print` or `PRINT`, and the line holds the PRINT token once it is entered. `goto` and `gosub` work as well as `go to` and `go sub`, and so do `<=`, `>=` and `<>` typed as two characters. Spaces may be typed as you like: the one LIST shows on each side of a keyword is left out of the line, and any others are kept, as the ROM keeps spaces you type. LIST shows a space kept before a keyword as the keyword's own, so while the cursor is on such a line, EDITOR shows it with one space more, as the text that gives the line back.

A keyword is only taken as one when it is a whole word, so `printer` stays a variable, and nothing between quotes or after REM is changed.

* **Letters and digits** type themselves. Letters are small unless CAPS SHIFT is held or CAPS LOCK is on.
* **SYMBOL SHIFT** types the symbol on a key. The keys whose symbol is a keyword type its letters: SYMBOL SHIFT with Q, W, E, A, S, D, F, G, Y, U or I types `<=`, `<>`, `>=`, `STOP`, `NOT`, `STEP`, `TO`, `THEN`, `AND`, `OR` or `AT`, with a space after it where LIST puts one, and a space before it when it follows a letter or digit.
* **CAPS SHIFT and 2** (CAPS LOCK) switches capitals on and off.
* **CAPS SHIFT and 9** (GRAPHICS) switches graphics mode on and off. In it, 1 to 8 type the block graphics (inverted with CAPS SHIFT) and A to U the user-defined graphics; 9 leaves graphics mode and 0 deletes.
* **EXTEND** (CAPS SHIFT and SYMBOL SHIFT together), then SYMBOL SHIFT with a key, types the symbols only the ROM's E mode gives: `~` `|` `\` `{` `}` `[` `]` and `©`.
* **EXTEND, then a digit**, types a colour control into the line, as the ROM's E mode does: 0 to 7 PAPER, with CAPS SHIFT INK; 8 and 9 BRIGHT 0 and 1, with CAPS SHIFT FLASH 0 and 1.
* **EXTEND, then I**, switches between inserting and overtyping.

## Keys

| Key | What it does |
| --- | --- |
| ENTER | Enters the line: it goes into the program, or runs if it has no number. |
| ← → (CAPS SHIFT and 5, 8) | Moves the cursor a character along the line. |
| ↑ ↓ (CAPS SHIFT and 7, 6) | Moves the cursor a row up or down, onto the line before or after when it leaves this one. |
| DELETE (CAPS SHIFT and 0) | Deletes the character before the cursor. |
| CAPS SHIFT and 3, or EXTEND then U | Page up: the listing a screen further up. |
| CAPS SHIFT and 4, or EXTEND then J | Page down: the listing a screen further down. |
| EDIT (CAPS SHIFT and 1) | Undoes the changes made to the line under the cursor. |
| BREAK (CAPS SHIFT and SPACE) | Undoes the changes made to the line, or cancels a question on the status row. |
| CAPS LOCK (CAPS SHIFT and 2) | Capitals on and off. |
| GRAPHICS (CAPS SHIFT and 9) | Graphics mode on and off. |
| EXTEND (CAPS SHIFT and SYMBOL SHIFT) | The next key is one of the EXTEND commands below. |

On a PC keyboard the arrow keys and Backspace work as the Spectrum's arrows and DELETE.

## EXTEND commands

Press EXTEND, then the letter. A command that needs numbers asks for them on the status row, offering a sensible answer: type over it (DELETE rubs out), then press ENTER, or BREAK to cancel. Two numbers are typed with a comma between them. A first number of 0 is taken as 1, since no line is numbered 0, and a number above 16383, the highest a line can have, as 16383. What is typed stops where the status row ends.

| Keys | Command |
| --- | --- |
| EXTEND, A | **Auto line numbers.** Asks for the first number and the step (such as `100,10`). From then on the new line starts with the next number, the cursor after it, until EXTEND A again turns it off. |
| EXTEND, F | **Find.** Asks for some text, and puts the cursor on the next line that has it, after the cursor's line and round to the start. Small letters and capitals are alike. |
| EXTEND, N | **Find next.** The same text again. |
| EXTEND, G | **Go to.** Asks for a line number, and puts the cursor on that line or the first after it. |
| EXTEND, R | **Renumber.** Asks for the first number and the step, and numbers every line again. See below. |
| EXTEND, D | **Delete lines.** Asks for the first and the last line number, and once you press Y, deletes the lines between them. |
| EXTEND, X | **Delete this line** from the program. |
| EXTEND, U | **Page up**: the listing a screen further up, the cursor staying on its row. |
| EXTEND, J | **Page down**: the listing a screen further down. J is just below U on the keyboard. |
| EXTEND, T | To the **top**: the first line. |
| EXTEND, B | To the **bottom**: the new line at the end. |
| EXTEND, H | To the start of the line. |
| EXTEND, E | To the end of the line. |
| EXTEND, I | Insert or overtype. |
| EXTEND, Q | **Quits** EDITOR for the ROM's editor, which lists the program. `RANDOMIZE USR 53248` comes back. |

### Renumbering

Every line is numbered again, from the first number in steps of the second. A `GO TO`, `GO SUB`, `RUN`, `RESTORE`, `LIST`, `LLIST` or `SAVE ... LINE` that names a line as a plain number is changed to the line's new number. If no line had that number, it goes to the first line after it. A number past the last line stays past the last line.

The line is made longer or shorter if the new number has more or fewer digits, and the number's hidden 5-byte form is changed with it, so the program is exactly what typing the renumbered listing would have made. A `GO TO` or `GO SUB` to anything other than a plain number, such as `GO TO n*10`, cannot be followed: those are left as they are, and the status row says how many there were. Renumbering is refused if the last number would pass 9999, or if there is not room for the longer lines.

## Entering lines

**ENTER** sends the line to the ROM, which checks it as it checks a line typed into its own editor. If the ROM finds a mistake, the line stays where it is, the cursor goes to where the ROM stopped, the character there is shown inverted, the ROM's report (such as *C Nonsense in BASIC*) shows on the status row, and the Spectrum gives a short low rasp. Put it right and press ENTER again.

A line that goes in replaces any line with the same number. As in the ROM:

* A number on its own deletes that line.
* Changing a line's number and entering it makes a copy under the new number, leaving the old line as it was.

ENTER on a line you have not changed opens a new line just below it.

**Moving off a changed line** enters it, so that nothing typed is lost. If the ROM refuses it, the cursor stays on it. A changed line without a number, or numbered 0, cannot be left this way, since the ROM takes it as a command: press ENTER to run it, or BREAK to undo it.

## Commands

A line without a number is a command, and ENTER runs it as the ROM runs a typed command: `RUN`, `PRINT 2+2`, `LOAD ""`, `SAVE "name"`, `CLEAR`, `CAT` with the Interface 1, anything. The screen is cleared first, as LIST's listing would be, and what the command or program prints stays on the screen with the ROM's report under it until you press a key; then EDITOR comes back, on the line where you were. A command that prints nothing, such as `LET a=1`, has its report shown on the status row instead.

EDITOR comes back however the program stops: at its end, at STOP, on an error, on BREAK, or after a LOAD or MERGE. INPUT is the ROM's own, and works as usual.

`NEW` typed as a command, as its first statement, is EDITOR's own: it clears everything as the ROM's NEW does, and EDITOR stays. A NEW after another statement, such as `LET a=1: NEW` or `IF a THEN NEW`, is the ROM's, as in a program, and lets go of EDITOR. A `CLEAR` to 53248 or more is refused with *M RAMTOP no good*, typed or in a program, since BASIC's stack would go into EDITOR: while EDITOR is in charge, the highest RAMTOP the ROM's CLEAR allows (the system variable P_RAMT) is held at 53247. So `CLEAR USR "a"-1`, for one, is refused; a program that needs it runs once `RANDOMIZE USR 53254` has let go of EDITOR.

## Memory

EDITOR lives above RAMTOP, at 53248 and up, so BASIC keeps about 29K for programs and variables:

| Addresses | What is there |
| --- | --- |
| 53248 to 62990 | The machine code and the font, as loaded from the tape. |
| 63002 to 63999 | The line being edited, the screen map, EDITOR's variables and the row being drawn. |
| 64000 to 65019 | The font laid out a pixel line at a time, built when EDITOR starts, so that the screen is drawn quickly. |
| 65021 to 65023 | A jump to the interrupt routine. |
| 65024 to 65280 | The IM 2 table. |
| 65281 to 65310 | The interrupt routine. |
| 65312 to 65344 | What is typed at a prompt on the status row. |
| 65368 to 65535 | The user-defined graphics, left as they are. |

## How EDITOR stays in charge

EDITOR runs the Spectrum in interrupt mode 2. Fifty times a second its interrupt routine calls the ROM's own (which counts the frames and reads the keyboard), then looks to see whether the ROM's editor is waiting for a command. That is where the ROM always ends up after a report, a BREAK, a program's end or a LOAD, and EDITOR takes over from it there. A few things take EDITOR away; `RANDOMIZE USR 53248`, typed into the ROM's editor, brings it back if its code is still intact:

* A program that sets its own interrupt mode, as many games and some machine code utilities do.
* `RANDOMIZE USR 0`, or NEW run from inside a program or after another statement of a command, rather than typed as a command of its own. After such a NEW, the ROM still refuses a CLEAR above 53247 until `RANDOMIZE USR 53254`.
* Machine code loaded over 53248 to 65367.

## Things to know

* **Keywords inside quotes.** In the ROM's editor, a keyword key pressed inside quotes puts the keyword's token into the string. In EDITOR, letters typed inside quotes stay letters, as in 128 BASIC. Tokens already inside a string are kept as they are, and listed as LIST lists them.
* **Variables named like keywords.** A new line typed with a variable called, say, `pi` or `at` gets the keyword instead, as in 128 BASIC. A line already in the program keeps its variables when you edit it: EDITOR looks for keywords in capitals first on such a line, as LIST writes keywords in capitals and variables as they were typed.
* **Very long lines.** A line longer than 512 characters as listed (over 12 rows) can be run, deleted with EXTEND X or renumbered, but not edited. It is shown in full up to 100 rows (4200 characters), and only its first 100 rows beyond that. Lines typed by hand are far shorter: the longest in the starter programs lists as about 220 characters. Lines this long are mostly made by programs, such as a REM holding machine code.
* **Very large line numbers.** A line numbered above 9999, which only a program changed by POKE can have, is shown but cannot be entered again, since the ROM refuses such a number.
* **The emulator's helpers.** The emulator's Type in button and the on-screen keyboard's mode legends follow the ROM's editor, and do not know about EDITOR. Quit EDITOR (EXTEND, Q) before using Type in.

## How it works

How EDITOR works, routine by routine, is in the comments of [starter/editor.asm](../starter/editor.asm). How it is assembled onto the cassette and tested against the ROM is in [docs/tech_notes.md](tech_notes.md), under Starter programs.
