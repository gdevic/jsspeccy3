; EDITOR: a full-screen BASIC editor for the ZX Spectrum 48K, in 42 columns.
;
; The whole screen shows the program as LIST shows it, in a 5x7 font in
; cells of 6 by 8 pixels, 42 columns and 23 rows, with a status row at the
; bottom. The cursor moves anywhere on the listing, keywords are typed
; letter by letter, and a line goes into the program when ENTER is pressed
; on it or the cursor leaves it. A line without a number is a command, and
; runs as one. docs/editor.md tells how to use it; this file is how it
; works.
;
; Nothing here makes its own BASIC. A line is turned into the bytes the
; ROM's keyboard would have put in the editing area (its keywords as
; tokens), put there with the ROM's own ADD-CHAR, checked by the ROM's own
; LINE-SCAN, which refuses a mistake and adds the hidden 5-byte form of
; every number, and stored by a copy of the ROM's MAIN-ADD. A command runs
; through the ROM's MAIN-3, as a typed one does. A line on the screen is
; listed as the ROM's OUT-LINE lists it, keywords spaced by PO-TOKENS'
; rules and words from the ROM's own keyword table, and the line under the
; cursor is read back from the same listing.
;
; The screen is drawn a row at a time: the characters of a row are put in
; ROWBUF, and the row is written to the screen once it is complete, every
; four cells as three whole bytes, each pixel line of a cell found in one
; load from the glyph table GT, which holds the font a pixel line at a time.
;
; The editor stays in charge through IM 2: every frame, after the ROM's
; own frame counter and keyboard scan, the interrupt routine looks for the
; ROM's editor waiting for a command at the top level, which is where the
; ROM ends up after a report, BREAK, NEW, CLEAR, LOAD or a program's end,
; and takes over from it there. A program that sets its own interrupt
; mode, as many games do, drops the editor until RANDOMIZE USR 53248.
; While the editor is in charge, P_RAMT, the highest RAMTOP the ROM's CLEAR
; allows, is held just below it, so that no CLEAR, typed or in a program,
; can put BASIC's stack into the editor; the real P_RAMT is put back when
; the editor lets go.
;
; tools/gen-starter.js assembles this (tools/z80asm.js) and saves it after
; the EDITOR loader on the Projects cassette. tools/test-editor.js checks
; it against the ROM, which is the golden value.
;
; Memory, above RAMTOP (the loader does CLEAR 53247):
;   $D000-   the code and the font, saved on the tape
;   $F61A-   the line being edited (EDBUF), the screen map, the editor's
;            variables and the row being drawn, not saved
;   $FA00-   the glyph table GT, built by START from the font (to $FDFB)
;   $FDFD    JP to the interrupt routine, written by START
;   $FE00-   the IM 2 table, 257 bytes of $FD, written by START
;   $FF01-   the interrupt routine, copied there by START
;   $FF20-   what is typed at a prompt (PBUF)
;   $FF58-   the user-defined graphics, left alone
;
; Registers: IY stays at $5C3A and HL' is never changed, as BASIC needs.
; IX is not used, since the ROM's BEEPER uses it.

; ---------------------------------------------------------------------------
; The ROM
; ---------------------------------------------------------------------------

TKN_TABLE   EQU $0096       ; the keywords, RND first, last letter +$80
KEY_E_LET   EQU $022C       ; K-DECODE's E mode letters, A to Z
BEEPER      EQU $03B5       ; HL, DE: a beep
PO_MSG      EQU $0C0A       ; A, DE: message A of the table at DE
ADD_CHAR    EQU $0F81       ; A: put into the editing area at K_CUR
REMOVE_FP   EQU $11A7       ; HL: take the hidden numbers out of a line
MAIN_EXEC   EQU $12A2       ; list, then the ROM's editor
MAIN_3      EQU $12CF       ; run the command in the editing area
EDITOR_RET  EQU $12B4       ; where the ROM's editor returns to in MAIN-2
ED_ERROR    EQU $107F       ; the ROM editor's error handler
REPORTS     EQU $1391       ; the reports' messages
COMMA_MSG   EQU $1536       ; ", "
CHAN_OPEN   EQU $1601       ; A: open stream A
MAKE_ROOM   EQU $1655       ; HL, BC: BC bytes at HL, the rest moved up
SET_MIN     EQU $16B0       ; empty the editing area
LINE_ADDR   EQU $196E       ; HL: the first line from line HL
RECLAIM_1   EQU $19E5       ; DE to HL: given back
RECLAIM_2   EQU $19E8       ; HL, BC: BC bytes at HL given back
E_LINE_NO   EQU $19FB       ; BC: the editing area's line number
OUT_NUM_1   EQU $1A1B       ; BC: print a number
LINE_SCAN   EQU $1B17       ; check the editing area's line
TEST_ROOM   EQU $1F05       ; BC: report 4 if there is no room
BREAK_KEY   EQU $1F54       ; NC if CAPS SHIFT and SPACE are down
NEW_RAMSET  EQU $1235       ; NEW's setting up, after its IM 1

; The system variables
LAST_K      EQU $5C08
RASP        EQU $5C38
ERR_NR      EQU $5C3A
FLAGS       EQU $5C3B
ERR_SP      EQU $5C3D
MODE        EQU $5C41
PPC         EQU $5C45
SUBPPC      EQU $5C47
E_PPC       EQU $5C49
CURCHL      EQU $5C51
PROG        EQU $5C53
E_LINE      EQU $5C59
CH_ADD      EQU $5C5D
X_PTR       EQU $5C5F
WORKSP      EQU $5C61
FLAGS2      EQU $5C6A
FLAGX       EQU $5C71
FRAMES      EQU $5C78
UDG         EQU $5C7B
RAMTOP      EQU $5CB2
P_RAMT      EQU $5CB4

; Tokens
T_LINE      EQU $CA
T_RESTORE   EQU $E5
T_NEW       EQU $E6
T_REM       EQU $EA
T_GOTO      EQU $EC
T_GOSUB     EQU $ED
T_LIST      EQU $F0
T_LLIST     EQU $E1
T_RUN       EQU $F7

; Keys, as K-DECODE gives them in L mode
K_TRUEVID   EQU $04         ; CAPS SHIFT+3: page up
K_INVVID    EQU $05         ; CAPS SHIFT+4: page down
K_CAPSLOCK  EQU $06         ; CAPS SHIFT+2
K_EDIT      EQU $07         ; CAPS SHIFT+1
K_LEFT      EQU $08
K_RIGHT     EQU $09
K_DOWN      EQU $0A
K_UP        EQU $0B
K_DELETE    EQU $0C         ; CAPS SHIFT+0
K_ENTER     EQU $0D
K_EXTEND    EQU $0E         ; CAPS SHIFT+SYMBOL SHIFT
K_GRAPHICS  EQU $0F         ; CAPS SHIFT+9
K_BREAK     EQU $01         ; CAPS SHIFT+SPACE, which K-DECODE gives as a space

; Line keys: a line is known by its number. These stand for the others.
SLOT        EQU $FFFF       ; the new line, which is not in the program
ENDKEY      EQU $FFFE       ; past the end of the listing
SLOTEND     EQU $4000       ; SLOTBEF when the new line is after every line
NUMMAX      EQU $3FFF       ; the highest number a line can have: a number
                            ; typed at a prompt goes no higher

ROWS        EQU 23          ; listing rows, 0 to 22; row 23 is the status
COLS        EQU 42
MAXROWS     EQU 100         ; the most rows a line is drawn in, so that a row
                            ; on or near the screen fits in a signed byte
ATTR_LIST   EQU $38         ; black on white
ATTR_STATUS EQU $07         ; white on black
EDMAX       EQU 512         ; the longest line the editor edits, as listed

; ---------------------------------------------------------------------------
; Memory above the code, not saved on the tape
; ---------------------------------------------------------------------------

EDBUF       EQU $F61A       ; the line being edited, as text (EDMAX bytes)
ROWMAP      EQU $F81A       ; each listing row: line key (2), row in it (1)
VARBASE     EQU $F860       ; the variables below, cleared by START
CELLPAGE    EQU $F900       ; a page of the row being drawn and others:
SLOTLO      EQU CELLPAGE    ;   each cell's glyph slot, for pixel lines 0-3
FINDSTR     EQU CELLPAGE+$2A ;  what EXTEND F looks for, 0 at its end (33)
TOKIDX      EQU CELLPAGE+$4B ;  where every eighth keyword starts in the ROM (12 words)
SLOTHI      EQU CELLPAGE+$80 ;  each cell's slot +$80, for pixel lines 4-7
ROWBUF      EQU CELLPAGE+$AA ;  the row's cells, as their codes (COLS)
DYNCODE     EQU CELLPAGE+$D4 ;  the cell code made in each of the row's own slots
LNDIGITS    EQU CELLPAGE+$64 ;  a line number being listed, written out (6)
KQBUF       EQU CELLPAGE+$6A ;  the keys waiting to be read (16)
GLYPH       EQU CELLPAGE+$F0 ;  a cell being made, 8 rows in bits 7-2
GT          EQU $FA00       ; the glyph table: four pages, pixel lines 0-3 in
                            ; their lower halves and 4-7 in their upper halves,
                            ; each half a slot a cell: the font's 96 characters,
                            ; then DYNMAX made for the row being drawn
DYNSLOT     EQU 96          ; the first of the row's own slots
DYNMAX      EQU 28          ; how many: the last ends at $FDFB, below the IM 2 jump

EDFLAGS     EQU VARBASE+0   ; bit 0: show the editor without a key first
                            ; bit 1: the report is to show on the status row
CURLINE     EQU VARBASE+2   ; the line under the cursor (a key)
SLOTBEF     EQU VARBASE+4   ; the new line is just before the first line from this
TOPLINE     EQU VARBASE+6   ; the line at the top of the screen (a key)
TOPSKIP     EQU VARBASE+8   ; its rows above the screen
EDLEN       EQU VARBASE+10  ; EDBUF's length
CURIDX      EQU VARBASE+12  ; the cursor's place in EDBUF
COLWANT     EQU VARBASE+14  ; the column up and down keep to
MODIFIED    EQU VARBASE+15  ; EDBUF differs from the line it came from
INSMODE     EQU VARBASE+16  ; 1 insert, 0 overtype
AUTOON      EQU VARBASE+17  ; auto line numbers on
AUTONEXT    EQU VARBASE+18  ; the number auto gives next
AUTOSTEP    EQU VARBASE+20
ERRIDX      EQU VARBASE+22  ; where in EDBUF the ROM found a mistake, or $FFFF
CURTOP      EQU VARBASE+24  ; the screen row the cursor's line starts at (signed)
CURROWS     EQU VARBASE+25  ; how many rows the cursor's line takes
CURSUB      EQU VARBASE+26  ; the cursor's row within its line
CURCOL      EQU VARBASE+27  ; the cursor's column
CXROW       EQU VARBASE+28  ; where the cursor blinks: row ($FF: nowhere)
CXCOL       EQU VARBASE+29  ; and column
CURSHOWN    EQU VARBASE+30  ; the cursor is drawn
READONLY    EQU VARBASE+31  ; the line is too long to edit
MSGPTR      EQU VARBASE+32  ; a message for the status row, or 0
DRAWROW     EQU VARBASE+34  ; where the channel puts the next cell (signed)
DRAWCOL     EQU VARBASE+35
DRAWMODE    EQU VARBASE+36  ; 0 draw, 1 measure, 2 capture
DRAWINV     EQU VARBASE+37  ; the next cell inverse
PARAMS      EQU VARBASE+38  ; control code parameters still to come
EXPANDING   EQU VARBASE+39  ; a token is being written out
REMSEEN     EQU VARBASE+40  ; the line being captured has had its REM
CLIPLO      EQU VARBASE+41  ; rows drawn: CLIPLO to CLIPHI
CLIPHI      EQU VARBASE+42
CAPPTR      EQU VARBASE+43  ; where capture puts the next byte
CAPLIM      EQU VARBASE+45  ; and where it must stop
CAPFULL     EQU VARBASE+47  ; capture ran out of room
DRAWSTART   EQU VARBASE+48  ; the row EDBUF is drawn from (signed)
WANTROW     EQU VARBASE+49  ; locate: the row in the line
WANTCOL     EQU VARBASE+50  ; and column wanted
WANTIDX     EQU VARBASE+51  ; the place found (2)
TOKUPPER    EQU VARBASE+53  ; keywords only in capitals
TOKMODE     EQU VARBASE+54  ; 0 into the editing area, 1 counting
TOKCOUNT    EQU VARBASE+55  ; bytes made so far (2)
TOKTARGET   EQU VARBASE+57  ; counting: the byte whose place is wanted (2)
TOKFOUND    EQU VARBASE+59  ; counting: its place in EDBUF (2)
TKEND       EQU VARBASE+61  ; the end of EDBUF (2)
TQUOTED     EQU VARBASE+63
TREM        EQU VARBASE+64
THELD       EQU VARBASE+65  ; a space held back
TSKIP1      EQU VARBASE+66  ; one space to skip, after a keyword
TPREV       EQU VARBASE+67  ; the character before was a letter or digit
BESTLEN     EQU VARBASE+68  ; the longest keyword matched (2)
BESTTOK     EQU VARBASE+70
BESTEND     EQU VARBASE+71  ; (2)
MATCHEND    EQU VARBASE+73  ; (2)
LASTERR     EQU VARBASE+75  ; ERR_NR when the editor came back
SAVEPPC     EQU VARBASE+76  ; not used (2)
SAVECHL     EQU VARBASE+78  ; (2)
EXTPEND     EQU VARBASE+80  ; EXTEND has been pressed
ROWSCOUNT   EQU VARBASE+81  ; scratch
NEEDALL     EQU VARBASE+82  ; the whole listing must be drawn again
RENSTART    EQU VARBASE+83  ; renumber: the first new number (2)
RENSTEP     EQU VARBASE+85  ; and the step (2)
RENCOUNT    EQU VARBASE+87  ; GO TO and GO SUB not renumbered (2)
RENGROW     EQU VARBASE+89  ; bytes the program grows by (2)
RENDRY      EQU VARBASE+91  ; 1 while only counting
NUMA        EQU VARBASE+92  ; numbers read from a prompt (2)
NUMB        EQU VARBASE+94  ; (2)
LINEADDR    EQU VARBASE+96  ; scratch: a line's address (2)
WALKN       EQU VARBASE+98  ; scratch (2)
WALKKEY     EQU VARBASE+100 ; scratch (2)
FINDHIT     EQU VARBASE+102 ; where in EDBUF the text was found (2)
PROMPTPTR   EQU VARBASE+104 ; the prompt's text (2)
DIGITS      EQU VARBASE+106 ; a number written out, up to 5 digits and 0
SCROLLN     EQU VARBASE+112 ; rows to scroll
LASTNUM     EQU VARBASE+113 ; the last new number (2)
DBCOUNT     EQU VARBASE+115 ; bytes taken out of EDBUF (2)
MKSTART     EQU VARBASE+117 ; where a keyword is looked for (2)
MKTOK       EQU VARBASE+119 ; the keyword being tried
TRYOFF      EQU VARBASE+120 ; where in the editing area the ROM stopped (2)
EVGUARD     EQU VARBASE+122 ; times the listing has been moved for the cursor
NTPOW       EQU VARBASE+123 ; NUMTEXT's power of ten (2)
NTSTARTED   EQU VARBASE+125 ; NUMTEXT has written a digit
WASSLOT     EQU VARBASE+126 ; the line left was the new line
KTOK        EQU VARBASE+127 ; the keyword being typed
TGTOK       EQU VARBASE+128 ; the keyword before a line number
LEFTSLOT    EQU VARBASE+129 ; LEAVE took an empty new line out of the middle
SLOTPREV    EQU VARBASE+130 ; and the line that was before it (2)
SLOTNEXT    EQU VARBASE+132 ; and the line that was after it (2)
SLOTPNONE   EQU VARBASE+134 ; there was none before it
DYNN        EQU VARBASE+136 ; the row's own slots made so far
ROWINV      EQU VARBASE+137 ; the column of ROWBUF drawn inverse, or $FF
EXPTOK      EQU VARBASE+138 ; the keyword being written out
CACHEOK     EQU VARBASE+139 ; the four below hold, while the listing is drawn
CACHEFROM   EQU VARBASE+140 ; the line just drawn (2)
CACHEKEY    EQU VARBASE+142 ; the line after it (2)
CACHEADDR   EQU VARBASE+144 ; and its address (2)
CACHENONE   EQU VARBASE+146 ; there is no line after it
BLROW       EQU VARBASE+147 ; the screen row being written
BLCOUNT     EQU VARBASE+148 ; its pixel lines still to write
BLEND       EQU VARBASE+149 ; where a pixel line's groups of four end
BLGROUPS    EQU VARBASE+150 ; the row's groups of four cells, up to the last not blank
BLTAIL      EQU VARBASE+151 ; and whether columns 40 and 41 are to be written too
BLPREP      EQU VARBASE+152 ; the cells given slots
KQHEAD      EQU VARBASE+153 ; the next key to be read from KQBUF
KQTAIL      EQU VARBASE+154 ; where the next key pressed goes in KQBUF
RENPEAK     EQU VARBASE+155 ; renumber: the most RENGROW comes to on the way (2)
CAPDIFF     EQU VARBASE+157 ; the line captured has a space LIST leaves out
CURDIFF     EQU VARBASE+158 ; and so has the current line: it is shown so
VAREND      EQU VARBASE+159

ISRAT       EQU $FF01       ; where the interrupt routine runs
IM2TABLE    EQU $FE00
IM2JUMP     EQU $FDFD
PBUF        EQU $FF20       ; what is typed at a prompt, 0 at its end (33),
                            ; after the interrupt routine
PBUFMAX     EQU 32
OFFER       EQU PBUF        ; the text a prompt starts with, made in place

; ---------------------------------------------------------------------------
; Entry points
; ---------------------------------------------------------------------------

        ORG $D000

ENTRY:  JP START            ; 53248: start, keeping the program
        JP STARTNEW         ; 53251: start with NEW (the loader uses this)
        JP UNHOOK           ; 53254: let go, back to the ROM's editor
STATE:  DB 0                ; 53257: 0 not running, 1 waiting for a key, 2 busy

; START: RANDOMIZE USR 53248. Hooks the editor in and goes back to BASIC,
; which finishes the line it was on; the ROM's editor then waits for the
; next command, and the interrupt routine takes over from it.
START:  CALL CHECKTOP
        CALL INSTALL
        LD HL,EDFLAGS
        SET 0,(HL)          ; nothing to look at before the editor shows
        RET

; STARTNEW: RANDOMIZE USR 53251, as START but with NEW, so that the loader
; is not left in the listing.
STARTNEW:
        CALL CHECKTOP
        CALL INSTALL
        LD HL,EDFLAGS
        SET 0,(HL)
        JP SOFTNEW

; UNHOOK: RANDOMIZE USR 53254. IM 1 again, as the ROM sets it, and the
; real P_RAMT.
UNHOOK: DI
        IM 1
        LD A,$3F
        LD I,A
        XOR A
        LD (STATE),A
        CALL FREETOP
        EI
        RET

; Report M (RAMTOP no good) if RAMTOP is not below the editor, which would
; leave BASIC's stack in it.
CHECKTOP:
        LD A,(RAMTOP+1)
        CP HIGH ENTRY
        RET C
        RST $08
        DB $15

; P_RAMT while the editor is in charge: the ROM's CLEAR refuses a RAMTOP
; above it with report M, whatever the statement or the expression.
PRAMTCAP    EQU ENTRY-1

; FREETOP: P_RAMT as it was before the editor held it down, if it is still
; held down.
FREETOP:
        LD HL,(P_RAMT)
        LD DE,PRAMTCAP
        AND A
        SBC HL,DE
        RET NZ
        LD HL,(ISRPRAMT)
        LD (P_RAMT),HL
        RET

; INSTALL: P_RAMT held down, the IM 2 table, the jump and the interrupt
; routine, the variables, and IM 2. The real P_RAMT is kept in the
; interrupt routine, which puts it back if it lets go; one held down by an
; earlier START is not taken for it, and one already below the editor
; stays as it is.
INSTALL:
        DI
        LD HL,(P_RAMT)
        LD DE,PRAMTCAP
        AND A
        SBC HL,DE           ; Z: held down already
        ADD HL,DE           ; HL back, Z kept, and carry if below the editor
        JR Z,IN1
        LD (ISRPRAMT),HL
        JR C,IN1
        LD (P_RAMT),DE
IN1:    LD HL,IM2TABLE
        LD (HL),HIGH IM2JUMP
        LD DE,IM2TABLE+1
        LD BC,256
        LDIR                ; 257 bytes of $FD: any byte on the bus finds $FDFD
        LD A,$C3
        LD (IM2JUMP),A
        LD HL,ISRAT
        LD (IM2JUMP+1),HL
        LD HL,ISRCODE
        LD DE,ISRAT
        LD BC,ISREND-ISRCODE
        LDIR
        CALL INITVARS
        CALL BUILDGT
        CALL BUILDTOK
        LD A,HIGH IM2TABLE
        LD I,A
        IM 2
        EI
        RET

; BUILDGT: the font into the glyph table: character c's pixel line l at
; page HIGH GT + l%4, offset c-$20, +$80 for lines 4 to 7. The eighth line
; is always empty.
BUILDGT:
        LD HL,FONT
        LD C,0              ; the character's slot
BG1:    LD B,0              ; the pixel line
BG2:    LD A,B
        AND 3
        ADD A,HIGH GT
        LD D,A
        LD E,C
        BIT 2,B
        JR Z,BG3
        SET 7,E
BG3:    LD A,B
        CP 7
        LD A,0
        JR Z,BG4
        LD A,(HL)
        INC HL
BG4:    LD (DE),A
        INC B
        LD A,B
        CP 8
        JR NZ,BG2
        INC C
        LD A,C
        CP DYNSLOT
        JR NZ,BG1
        RET

; BUILDTOK: TOKIDX, where every eighth keyword of the ROM's table starts,
; so that TOKENTRY steps over at most 7.
BUILDTOK:
        LD HL,TKN_TABLE
        LD DE,TOKIDX
        LD C,0              ; the keyword's number, RND 0
BK1:    LD A,C
        AND 7
        JR NZ,BK2
        LD A,L
        LD (DE),A
        INC DE
        LD A,H
        LD (DE),A
        INC DE
BK2:    BIT 7,(HL)
        INC HL
        JR Z,BK2
        INC C
        LD A,C
        CP 91
        JR NZ,BK1
        RET

; INITVARS: every variable to its starting value: the cursor on the new
; line at the end of the program, the listing from the top, insert mode.
INITVARS:
        LD HL,VARBASE
        LD B,VAREND-VARBASE
IV1:    LD (HL),0
        INC HL
        DJNZ IV1
        LD HL,SLOT
        LD (CURLINE),HL
        LD HL,SLOTEND
        LD (SLOTBEF),HL
        LD HL,0
        LD (TOPLINE),HL
        LD A,1
        LD (INSMODE),A
        LD HL,10
        LD (AUTOSTEP),HL
        LD HL,$FFFF
        LD (ERRIDX),HL
        LD A,$FF
        LD (CXROW),A
        XOR A
        LD (FINDSTR),A
        RET

; ---------------------------------------------------------------------------
; The interrupt routine
; ---------------------------------------------------------------------------
;
; ISRCODE is copied to ISRAT, at the top of memory, where BASIC's stack
; cannot reach it while RAMTOP is below the editor; it uses only relative
; jumps inside itself. After the ROM's own interrupt work it looks at
; RAMTOP. Below the editor, the editor's code is safe, and ISRMAIN goes on
; there. In the editor, which only a POKE can do while P_RAMT is held
; down, the code may be overwritten, so the routine lets go of the editor
; at once and puts back the real P_RAMT, which it keeps for that.

ISRCODE:
        PUSH AF
        PUSH HL
        RST $38             ; the ROM's: FRAMES, the keyboard; it ends with EI
        DI
        LD A,(RAMTOP+1)
        CP HIGH ENTRY
        JP C,ISRMAIN        ; the code is safe below RAMTOP
        IM 1                ; RAMTOP is in the editor: let go of it
        LD A,$3F
        LD I,A
        LD HL,(ISRAT+ISRPRAMT-ISRCODE)
        LD (P_RAMT),HL
        POP HL
        POP AF
        EI
        RET
ISRPRAMT:
        DW $FFFF            ; the real P_RAMT, set by INSTALL
ISREND:

; ISRMAIN: the rest of the interrupt routine, once RAMTOP is below the
; editor. After KEYQUEUE takes the key just pressed while the editor runs,
; it looks at the error handler the ROM has set. The ROM's editor, called
; from MAIN-2 at the top level to wait for a command, sets ED_ERROR at
; ERR_SP, the ERR_SP before it just above, and EDITOR_RET above that, as
; its return into MAIN-2; that slot is where the old ERR_SP points. Finding
; all three, with the ROM's editor not serving an INPUT, it puts back the
; top-level ERR_SP, drops everything below it, and jumps into the editor,
; as if MAIN-2 had called it.
ISRMAIN:
        CALL KEYQUEUE       ; the key, if any
        LD HL,(ERR_SP)
        LD A,(HL)
        CP LOW ED_ERROR
        JR NZ,ISROUT
        INC HL
        LD A,(HL)
        CP HIGH ED_ERROR
        JR NZ,ISROUT
        LD A,(FLAGX)
        AND $20
        JR NZ,ISROUT        ; an INPUT
        INC HL
        PUSH DE
        LD E,(HL)
        INC HL
        LD D,(HL)           ; DE: the old ERR_SP
        INC HL              ; HL: the slot above
        LD A,L
        CP E
        JR NZ,ISRPOP
        LD A,H
        CP D
        JR NZ,ISRPOP
        LD A,(HL)
        CP LOW EDITOR_RET
        JR NZ,ISRPOP
        INC HL
        LD A,(HL)
        CP HIGH EDITOR_RET
        JR NZ,ISRPOP
        LD (ERR_SP),DE      ; the ROM's editor waits at the top level: take over
        EX DE,HL
        INC HL
        INC HL
        LD SP,HL
        EI
        JP REENTRY
ISRPOP: POP DE
ISROUT: POP HL
        POP AF
        EI
        RET

; ---------------------------------------------------------------------------
; Coming back from the ROM
; ---------------------------------------------------------------------------
;
; REENTRY runs at the top level, as MAIN-2 does: SP is ERR_SP+2, so that a
; report from a routine called here comes back to where it was called
; from, as in the ROM. The report the ROM printed is still on the screen.

REENTRY:
        LD IY,ERR_NR
        SET 3,(IY+1)        ; FLAGS: L mode at once, as MAIN-4 left K mode, so
                            ; that a key pressed while the editor draws is a letter
        EXX
        LD HL,$2758         ; the calculator's HL', as BASIC keeps it
        EXX
        IM 2
        LD A,(KQTAIL)       ; keys typed before the command ran are dropped
        LD (KQHEAD),A
        LD A,2
        LD (STATE),A
        LD A,(ERR_NR)
        LD (LASTERR),A
        LD (IY+0),$FF
        LD HL,EDFLAGS
        BIT 0,(HL)
        JR NZ,RE2
        CALL UPPERUSED      ; did what ran print anything?
        JR Z,RE1
        CALL WAITANY        ; leave it on the screen until a key
        JR RE2
RE1:    LD HL,EDFLAGS
        SET 1,(HL)          ; nothing to see: the report goes on the status row
RE2:    LD HL,EDFLAGS
        RES 0,(HL)
        XOR A
        LD (MODE),A
        LD (EXTPEND),A
        CALL VIEWFIX
        CALL SETCURKEEP
        CALL SCREENINIT
        CALL RENDERALL
        CALL ENSUREVIS
        JP MAINLOOP

; UPPERUSED: NZ if anything is drawn on the screen above the bottom two
; rows, where the report is.
UPPERUSED:
        LD HL,$4000
        LD BC,$1000         ; rows 0 to 15
UU1:    LD A,(HL)
        AND A
        RET NZ
        INC HL
        DEC BC
        LD A,B
        OR C
        JR NZ,UU1
        LD HL,$5000         ; rows 16 to 21, in each of the 8 pixel lines
UU2:    LD B,6*32
UU3:    LD A,(HL)
        AND A
        RET NZ
        INC HL
        DJNZ UU3
        LD L,0
        INC H
        LD A,H
        CP $58
        JR NZ,UU2
        XOR A
        RET

; WAITANY: waits for a key, which is used up. MAIN-4 has cleared FLAGS
; bit 5 after the program stopped, so a key pressed since counts: the
; interrupt routine queues it once the editor is back.
WAITANY:
        EI
WA2:    HALT
        CALL KQGET
        JR NC,WA2
        RET

; SOFTNEW: NEW as the ROM does it, leaving the machine as the ROM's NEW
; leaves it but in IM 2. Every byte from $4000 to RAMTOP becomes 0 but for
; P_RAMT, RASP and PIP, and UDG, then the ROM sets everything up again
; from NEW's own code, after its IM 1, and goes on into its editor, which
; the interrupt routine takes over from.
SOFTNEW:
        DI
        LD HL,(P_RAMT)      ; kept above RAMTOP, where nothing is cleared
        LD (SNPRAMT),HL
        LD HL,(RASP)
        LD (SNRASP),HL
        LD HL,(UDG)
        LD (SNUDG),HL
        LD HL,(RAMTOP)
        LD (SNTOP),HL
        LD DE,$4000         ; the machine stack is about to go: no more calls
        AND A
        SBC HL,DE
        LD B,H
        LD C,L              ; RAMTOP-$4000 bytes after $4000
        LD HL,$4000
        LD (HL),0
        LD DE,$4001
        LDIR                ; $4000 to RAMTOP
        LD HL,(SNPRAMT)
        LD (P_RAMT),HL
        LD HL,(SNRASP)
        LD (RASP),HL
        LD HL,(SNUDG)
        LD (UDG),HL
        LD A,7
        OUT ($FE),A
        LD HL,(SNTOP)
        ; as RAM-SET at $1219, but IM 2
        LD (RAMTOP),HL
        LD HL,$3C00
        LD ($5C36),HL       ; CHARS
        LD HL,(RAMTOP)
        LD (HL),$3E
        DEC HL
        LD SP,HL
        DEC HL
        DEC HL
        LD (ERR_SP),HL
        IM 2
        LD IY,ERR_NR
        EI
        JP NEW_RAMSET
SNTOP:  DW 0
SNPRAMT: DW 0
SNRASP: DW 0
SNUDG:  DW 0

; QUIT: EXTEND Q. Back to the ROM's editor for good: IM 1, and the ROM's
; MAIN-EXEC lists the program and waits, the current line marked.
QUIT:   CALL LEAVE
        RET NZ
        CALL CURSOFF
        LD HL,(CURLINE)
        LD A,H
        CP HIGH SLOTEND
        JR NC,QU1
        LD (E_PPC),HL
QU1:    DI
        IM 1
        LD A,$3F
        LD I,A
        XOR A
        LD (STATE),A
        CALL FREETOP
        EI
        LD HL,(ERR_SP)
        INC HL
        INC HL
        LD SP,HL
        SET 0,(IY+48)       ; FLAGS2: the screen is to be cleared
        JP MAIN_EXEC

; ---------------------------------------------------------------------------
; The main loop and the keys
; ---------------------------------------------------------------------------

MAINLOOP:
        CALL STATUS
        CALL GETKEY
        PUSH AF
        LD HL,0
        LD (MSGPTR),HL      ; a message lasts until the next key
        LD HL,EDFLAGS
        RES 1,(HL)          ; and so does the report
        POP AF
        CALL DISPATCH
        LD A,(NEEDALL)
        AND A
        JR Z,MAINLOOP
        XOR A
        LD (NEEDALL),A
        CALL RENDERALL
        CALL ENSUREVIS
        JR MAINLOOP

; DISPATCH: does what key A asks.
DISPATCH:
        LD HL,EXTPEND
        BIT 0,(HL)
        JP NZ,EXTKEY
        CP K_ENTER
        JP Z,KENTER
        CP K_LEFT
        JP Z,KLEFT
        CP K_RIGHT
        JP Z,KRIGHT
        CP K_UP
        JP Z,KUP
        CP K_DOWN
        JP Z,KDOWN
        CP K_DELETE
        JP Z,KDELETE
        CP K_EDIT
        JP Z,KEDIT
        CP K_CAPSLOCK
        JP Z,KCAPS
        CP K_TRUEVID
        JP Z,KPGUP
        CP K_INVVID
        JP Z,KPGDN
        CP K_GRAPHICS
        JP Z,KGRAPH
        CP K_EXTEND
        JP Z,KEXTEND
        CP K_BREAK
        JP Z,KBRK
        CP $20
        RET C
        CP $A5
        JP C,KCHAR          ; a character, block graphic or UDG
        JP KTOKEN           ; a keyword from SYMBOL SHIFT

; GETKEY: waits for a key, with the cursor blinking, and gives it in A as
; the ROM's keyboard routine decodes it in L mode. CAPS SHIFT+SPACE comes
; as K_BREAK.
GETKEY: LD A,1
        LD (STATE),A
GK1:    SET 3,(IY+1)        ; FLAGS: L mode, for K-DECODE
        CALL KQGET
        JR C,GK2
        CALL BLINK
        EI
        HALT
        JR GK1
GK2:    PUSH AF
        CALL CURSOFF
        LD A,2
        LD (STATE),A
        CALL CLICK
        POP AF
        RET

; KEYQUEUE: called by the interrupt routine. While the editor runs (STATE
; not 0), the key the ROM's keyboard routine has just put in LAST_K goes
; into KQBUF, so that keys typed while the editor is busy drawing are all
; kept, where LAST_K holds only the last; CAPS SHIFT+SPACE goes in as
; K_BREAK. While a program runs, its keys are left to it.
KEYQUEUE:
        LD A,(STATE)
        AND A
        RET Z
        LD HL,FLAGS
        BIT 5,(HL)
        RET Z
        RES 5,(HL)
        LD A,(LAST_K)
        CP ' '
        JR NZ,KQ1
        CALL BREAK_KEY
        LD A,' '
        JR C,KQ1
        LD A,K_BREAK
KQ1:    PUSH DE
        LD E,A
        LD A,(KQTAIL)
        LD L,A
        INC A
        AND $0F
        LD D,A              ; where the tail goes next
        LD A,(KQHEAD)
        CP D
        JR Z,KQ2            ; 15 keys waiting, the most the 16 places hold
                            ; with head and tail apart: this one is lost
        LD A,L
        ADD A,LOW KQBUF
        LD L,A
        LD H,HIGH KQBUF
        LD (HL),E
        LD A,D
        LD (KQTAIL),A
KQ2:    POP DE
        RET

; KQGET: carry, and the key in A, if one is waiting in KQBUF.
KQGET:  DI
        LD A,(KQHEAD)
        LD L,A
        LD A,(KQTAIL)
        CP L
        JR Z,KQG1           ; none
        LD A,L
        INC A
        AND $0F
        LD (KQHEAD),A
        LD A,L
        ADD A,LOW KQBUF
        LD L,A
        LD H,HIGH KQBUF
        LD A,(HL)
        EI
        SCF
        RET
KQG1:   EI
        AND A
        RET

; CLICK: the keyboard's click, as the ROM's editor makes it.
CLICK:  LD HL,$00C8
        LD D,0
        LD E,(IY-1)         ; PIP
        JP BEEPER

; RASPB: the ROM editor's rasp, for a mistake, but short: 8 cycles of its
; 64 Hz tone, an eighth of a second, where RASP's 64 would last a second.
RASPB:  LD HL,$1A90
        LD DE,8
        JP BEEPER

; ---------------------------------------------------------------------------
; The cursor
; ---------------------------------------------------------------------------
;
; The cursor is the cell at CXROW, CXCOL drawn inverted: the whole cell in
; insert mode, its bottom row in overtype. It blinks with FRAMES.

BLINK:  LD A,(FRAMES)
        AND $10
        LD B,0
        JR NZ,BL0
        INC B               ; shown for 16 frames, hidden for 16
BL0:    LD A,(CURSHOWN)
        CP B
        RET Z
CURSXOR:
        LD A,(CXROW)
        CP 24
        RET NC              ; nowhere
        LD B,A
        LD A,(CXCOL)
        CP COLS
        RET NC
        LD C,A
        LD A,(INSMODE)
        AND A
        LD D,0
        LD E,8              ; lines 0 to 7
        JR NZ,CX1
        LD D,7
        LD E,1              ; line 7 only
CX1:    CALL XORCELL
        LD A,(CURSHOWN)
        XOR 1
        LD (CURSHOWN),A
        RET

; CURSOFF: the cursor hidden, before anything is drawn.
CURSOFF:
        LD A,(CURSHOWN)
        AND A
        RET Z
        JR CURSXOR

; ---------------------------------------------------------------------------
; Typing
; ---------------------------------------------------------------------------

; KCHAR: A typed at the cursor, inserted or over the character there.
KCHAR:  LD C,A
        CALL EDITABLE
        RET NZ
        LD A,(INSMODE)
        AND A
        JR NZ,KC1
        CALL ATEND
        JR Z,KC1
        PUSH BC
        CALL DELUNIT        ; overtype: the character under the cursor goes
        POP BC
KC1:    LD A,C
        CALL INSBYTE
        RET NZ
        JP CHANGED

; KTOKEN: a keyword from a SYMBOL SHIFT key, typed as its letters, with a
; space before it after a letter or digit, and a space after it where the
; listing would put one. <=, >= and <> are typed as their two characters.
KTOKEN: LD (KTOK),A
        CALL EDITABLE
        RET NZ
        LD C,6              ; room for one of four letters with a space each
        CALL ROOMFOR        ; side, so that none goes in half way
        RET NZ
        LD A,(KTOK)
        CALL TOKENTRY       ; HL: the keyword's text
        LD A,(HL)
        CALL ISLETTER
        JR NC,KT1
        CALL PREVALNUM
        JR NC,KT1
        LD A,' '
        PUSH HL
        CALL INSBYTE
        POP HL
        RET NZ
KT1:    LD A,(HL)
        AND $7F
        PUSH HL
        CALL INSBYTE
        POP HL
        RET NZ
        BIT 7,(HL)
        INC HL
        JR Z,KT1
        LD A,(KTOK)
        CALL TRAILING
        JR NC,KT2
        LD A,' '
        CALL INSBYTE
KT2:    JP CHANGED

; PREVALNUM: carry if the character before the cursor is a letter or digit.
PREVALNUM:
        PUSH HL
        LD HL,(CURIDX)
        LD A,H
        OR L
        JR Z,PA1
        LD DE,EDBUF-1
        ADD HL,DE
        LD A,(HL)
        POP HL
        JP ISALNUM
PA1:    POP HL
        AND A
        RET

; EDITABLE: Z if the line may be changed; NZ, with a message, if it is
; too long to.
EDITABLE:
        LD A,(READONLY)
        AND A
        RET Z
        LD HL,M_TOOLONG
        JP MESSAGE

; ROOMFOR: Z if EDBUF has room for C more bytes; NZ, with a message, if
; not. A is kept.
ROOMFOR:
        LD HL,EDMAX
        LD DE,(EDLEN)
        AND A
        SBC HL,DE           ; the room left
        LD B,0
        SBC HL,BC
        JR C,RM1
        CP A
        RET
RM1:    LD HL,M_FULL
        JP MESSAGE

; ATEND: Z if the cursor is at the end of the line.
ATEND:  LD HL,(CURIDX)
        LD DE,(EDLEN)
        AND A
        SBC HL,DE
        RET

; INSBYTE: A put into EDBUF at the cursor, which moves on past it. NZ,
; with a message, if the line is full.
INSBYTE:
        LD C,1
        CALL ROOMFOR
        RET NZ
        PUSH AF
        LD HL,(EDLEN)
        LD DE,(CURIDX)
        AND A
        SBC HL,DE           ; the bytes after the cursor
        LD B,H
        LD C,L
        LD HL,(EDLEN)
        LD DE,EDBUF-1
        ADD HL,DE           ; the last byte
        LD D,H
        LD E,L
        INC DE
        LD A,B
        OR C
        JR Z,IB2
        LDDR
IB2:    LD HL,(CURIDX)
        LD DE,EDBUF
        ADD HL,DE
        POP AF
        LD (HL),A
        LD HL,(EDLEN)
        INC HL
        LD (EDLEN),HL
        LD HL,(CURIDX)
        INC HL
        LD (CURIDX),HL
        XOR A
        RET

; DELBYTES: BC bytes taken out of EDBUF from place HL.
DELBYTES:
        LD (DBCOUNT),BC
        LD DE,EDBUF
        ADD HL,DE
        EX DE,HL            ; DE: where the bytes after them go
        LD H,D
        LD L,E
        ADD HL,BC           ; HL: the first byte kept
        PUSH HL
        LD HL,(EDLEN)
        LD BC,EDBUF
        ADD HL,BC           ; the end of the line
        POP BC
        AND A
        SBC HL,BC           ; bytes to move
        LD A,H
        OR L
        JR Z,DB1
        PUSH BC
        LD B,H
        LD C,L
        POP HL
        LDIR
DB1:    LD HL,(EDLEN)
        LD BC,(DBCOUNT)
        AND A
        SBC HL,BC
        LD (EDLEN),HL
        RET

; UNITLEN: A = how many bytes the unit at place HL in EDBUF has: 2 for a
; colour control and its number, 3 for AT or TAB and theirs, else 1.
UNITLEN:
        PUSH HL
        LD DE,EDBUF
        ADD HL,DE
        LD A,(HL)
        POP HL
        CP $10
        JR C,UL1
        CP $16
        JR C,UL2
        CP $18
        JR C,UL3
UL1:    LD A,1
        RET
UL2:    LD A,2
        RET
UL3:    LD A,3
        RET

; PREVUNIT: HL = the place of the unit before place HL.
PREVUNIT:
        LD (WALKN),HL
        LD HL,0
        LD B,H
        LD C,L              ; BC: the last unit's place
PU1:    PUSH HL
        LD DE,(WALKN)
        AND A
        SBC HL,DE
        POP HL
        JR NC,PU2
        LD B,H
        LD C,L
        CALL UNITLEN
        LD E,A
        LD D,0
        ADD HL,DE
        JR PU1
PU2:    LD H,B
        LD L,C
        RET

; DELUNIT: the unit at the cursor taken out.
DELUNIT:
        LD HL,(CURIDX)
        CALL UNITLEN
        LD C,A
        LD B,0
        LD HL,(CURIDX)
        JP DELBYTES

; KDELETE: the unit before the cursor taken out.
KDELETE:
        CALL EDITABLE
        RET NZ
        LD HL,(CURIDX)
        LD A,H
        OR L
        RET Z
        CALL PREVUNIT
        PUSH HL
        LD DE,(CURIDX)
        EX DE,HL
        AND A
        SBC HL,DE
        LD B,H
        LD C,L
        POP HL
        LD (CURIDX),HL
        CALL DELBYTES
        JP CHANGED

; CHANGED: the line has been changed: drawn again, and the mistake mark gone.
CHANGED:
        LD A,1
        LD (MODIFIED),A
        LD HL,$FFFF
        LD (ERRIDX),HL
        CALL REDRAWCUR
        LD A,(CURCOL)
        LD (COLWANT),A
        RET

; KLEFT, KRIGHT: the cursor one unit along the line.
KLEFT:  LD HL,(CURIDX)
        LD A,H
        OR L
        RET Z
        CALL PREVUNIT
        LD (CURIDX),HL
        JR KLR

KRIGHT: CALL ATEND
        RET Z
        LD HL,(CURIDX)
        CALL UNITLEN
        LD E,A
        LD D,0
        LD HL,(CURIDX)
        ADD HL,DE
        LD (CURIDX),HL
KLR:    CALL PLACECUR
        LD A,(CURCOL)
        LD (COLWANT),A
        RET

; KHOME, KEND: to the start or the end of the line.
KHOME:  LD HL,0
        LD (CURIDX),HL
        JR KLR

KEND:   LD HL,(EDLEN)
        LD (CURIDX),HL
        JR KLR

; KUP: a row up, within the line or onto the line before.
KUP:    LD A,(CURSUB)
        AND A
        JR Z,KU1
        DEC A
        JP MOVEROW
KU1:    CALL LEAVE
        RET NZ
        LD A,(LEFTSLOT)
        AND A
        JR Z,KU3
        LD HL,(SLOTPREV)    ; from a new line that has gone: the line before it
        LD A,(SLOTPNONE)
        RRA
        JR KU4
KU3:    LD HL,(CURLINE)
        CALL PREVKEY
KU4:    JR C,KU2            ; no line before
        CALL SETCUR
        LD A,(CURROWS)
        DEC A
        JP MOVEROWNEW
KU2:    CALL RENDERIFNEEDED
        RET

; KDOWN: a row down, within the line or onto the line after.
KDOWN:  LD A,(READONLY)
        AND A
        JR NZ,KD0           ; a line too long to edit: straight to the next
        LD A,(CURSUB)
        INC A
        LD HL,CURROWS
        CP (HL)
        JP C,MOVEROW
KD0:    CALL LEAVE
        RET NZ
        LD HL,(SLOTNEXT)    ; from a new line that has gone: the line after it
        LD A,(LEFTSLOT)
        AND A
        JR NZ,KD2
        LD HL,(CURLINE)
        CALL NEXTKEY
KD2:    LD A,H
        CP HIGH ENDKEY
        JR NZ,KD1
        LD A,L
        CP LOW ENDKEY
        JR Z,KU2            ; nothing after
KD1:    CALL SETCUR
        XOR A
        JP MOVEROWNEW

; MOVEROW: the cursor to row A of its line, as near column COLWANT as
; there is a character.
MOVEROW:
        CALL LOCATEROW
        JP PLACECUR

; MOVEROWNEW: as MOVEROW, onto a line just made current.
MOVEROWNEW:
        CALL LOCATEROW
        LD A,(NEEDALL)
        AND A
        JP Z,PLACECUR
        XOR A
        LD (NEEDALL),A
        CALL RENDERALL
        JP ENSUREVIS

; NEEDALLON: the whole listing to be drawn again (NEEDALL).
NEEDALLON:
        LD A,1
        LD (NEEDALL),A
        RET

; RENDERIFNEEDED: draws the listing again if a line went in.
RENDERIFNEEDED:
        LD A,(NEEDALL)
        AND A
        RET Z
        XOR A
        LD (NEEDALL),A
        CALL RENDERALL
        JP ENSUREVIS

; KPGUP, KPGDN: a screen up or down, the cursor staying on its row: CAPS
; SHIFT and 3 or 4, or EXTEND and U or J.
KPGUP:  CALL LEAVE
        RET NZ
        LD A,ROWS-1
        LD (SCROLLN),A
        LD HL,(TOPLINE)
        LD A,(TOPSKIP)
        LD C,A
        CALL BACKWALK       ; HL, C: the top ROWS-1 rows further up
        LD (TOPLINE),HL
        LD A,C
        LD (TOPSKIP),A
        JR PG1

KPGDN:  CALL LEAVE
        RET NZ
        LD HL,ROWMAP+((ROWS-1)*3)
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        LD A,D
        CP HIGH ENDKEY
        JR NZ,PD1
        LD A,E
        CP LOW ENDKEY
        JR Z,PG1            ; the end is on the screen already
PD1:    LD (TOPLINE),DE
        LD A,(HL)
        LD (TOPSKIP),A
PG1:    CALL CXROWNOW       ; the screen row the cursor is on
        PUSH AF
        CALL RENDERALL
        POP AF
        ; the line now on that row, or the last one
PG2:    LD (WANTROW),A
        CALL MAPADDR
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        LD A,D
        CP HIGH ENDKEY
        JR NZ,PG3
        LD A,E
        CP LOW ENDKEY
        JR NZ,PG3
        LD A,(WANTROW)
        AND A
        JR Z,PG3
        DEC A
        JR PG2
PG3:    LD A,(HL)           ; its row within the line
        PUSH AF
        EX DE,HL
        CALL SETCUR
        POP AF
        CALL LOCATEROW
        JP PLACECUR

; CXROWNOW: A = the screen row of the cursor, 0 to ROWS-1.
CXROWNOW:
        LD A,(CXROW)
        CP ROWS
        RET C
        XOR A
        RET

; KEDIT: the line as it is in the program again, the change undone.
KEDIT:  LD HL,(CURLINE)
        CALL SETCUR
        CALL REDRAWCUR
        JP ENSUREVIS

; KBRK: BREAK. A message goes; a change to the line is undone.
KBRK:   LD A,(MODIFIED)
        AND A
        RET Z
        JR KEDIT

; KCAPS: CAPS LOCK, in FLAGS2 where K-DECODE looks.
KCAPS:  LD A,(FLAGS2)
        XOR $08
        LD (FLAGS2),A
        RET

; KGRAPH: graphics mode, MODE 2, where K-DECODE gives the block graphics
; and the UDGs.
KGRAPH: LD A,(MODE)
        XOR 2
        AND 2
        LD (MODE),A
        RET

; KEXTEND: the next key is an EXTEND command. MODE 1 makes K-DECODE give
; it in E mode, so that the symbols only E mode gives (~ | \ { } [ ] and
; the copyright sign) can be typed.
KEXTEND:
        LD A,1
        LD (EXTPEND),A
        LD (MODE),A
        RET

; EXTKEY: the key after EXTEND, in A.
EXTKEY: LD HL,EXTPEND
        LD (HL),0
        LD HL,MODE
        LD (HL),0
        CP K_EXTEND
        RET Z               ; EXTEND again: nothing
        CP K_BREAK
        RET Z
        CALL ISLETTER       ; a letter decoded before MODE 1 took, typed fast
        JR NC,EK0
        AND $DF             ; in capitals
        JR EK4
EK0:    CP $20
        JP C,EXTCOLOUR      ; a digit: a colour control
        CP $80
        JP C,KCHAR          ; ~ | \ { } [ ] and the rest: typed
        CP $A5
        RET C
        ; an E mode letter comes as a keyword: which letter was it?
        LD HL,KEY_E_LET
        LD B,26
EK1:    CP (HL)
        JR Z,EK2
        INC HL
        DJNZ EK1
        RET                 ; a SYMBOL SHIFT keyword: nothing
EK2:    LD A,26+'A'
        SUB B
EK4:    LD HL,EXTTABLE
EK3:    LD C,(HL)
        INC HL
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        INC C
        DEC C
        RET Z               ; not a command
        CP C
        JR NZ,EK3
        EX DE,HL
        JP (HL)

EXTTABLE:
        DB 'A'
        DW KAUTO
        DB 'B'
        DW KBOTTOM
        DB 'D'
        DW KDELRANGE
        DB 'E'
        DW KEND
        DB 'F'
        DW KFIND
        DB 'G'
        DW KGOTO
        DB 'H'
        DW KHOME
        DB 'I'
        DW KINSERT
        DB 'J'
        DW KPGDN            ; under U on the keyboard
        DB 'N'
        DW KFINDNEXT
        DB 'Q'
        DW QUIT
        DB 'R'
        DW KRENUM
        DB 'T'
        DW KTOP
        DB 'U'
        DW KPGUP
        DB 'X'
        DW KDELLINE
        DB 0

; EXTCOLOUR: A from an E mode digit, made into its control and number as
; the ROM's KEY-INPUT makes it: 0-7 PAPER, with CAPS SHIFT INK; 8 and 9
; BRIGHT, with CAPS SHIFT FLASH.
EXTCOLOUR:
        LD B,A
        CP 6
        JR NC,EC1
        AND 1
        LD C,A              ; the number: 0 or 1
        LD A,B
        RRA
        ADD A,$12           ; FLASH or BRIGHT
        JR EC2
EC1:    CP $10
        RET C
        AND 7
        LD C,A
        LD A,$10            ; INK
        BIT 3,B
        JR NZ,EC2
        INC A               ; PAPER
EC2:    PUSH BC
        PUSH AF
        CALL EDITABLE
        LD C,2              ; room for both bytes, so that the control does
        CALL Z,ROOMFOR      ; not go in without its number
        POP BC              ; B: the control
        POP DE              ; E: the number
        RET NZ
        LD A,B
        PUSH DE
        CALL INSBYTE
        POP DE
        RET NZ
        LD A,E
        CALL INSBYTE
        RET NZ
        JP CHANGED

; KINSERT: insert and overtype.
KINSERT:
        LD A,(INSMODE)
        XOR 1
        LD (INSMODE),A
        RET

; KTOP, KBOTTOM: to the first line, or the new line at the end.
KTOP:   CALL LEAVE
        RET NZ
        LD HL,0
        CALL FIRSTGE
        JR NC,KTB
        JR KB1              ; no lines: the new line
KBOTTOM:
        CALL LEAVE
        RET NZ
KB1:    LD HL,SLOTEND
        LD (SLOTBEF),HL
        LD HL,SLOT
KTB:    CALL SETCUR         ; the cursor at its start, or after an auto number
        XOR A
        LD (COLWANT),A
        JP NEEDALLON

; ---------------------------------------------------------------------------
; Lines and keys
; ---------------------------------------------------------------------------
;
; The listing is the program's lines in order, with the new line (SLOT)
; just before the first line numbered SLOTBEF or more, or after the last
; when SLOTBEF is SLOTEND, and ENDKEY past them all. A line is always
; held by its number, never by its address, which moves whenever the
; program changes.

; LINEAT: HL = the address of the first line numbered HL or more; carry if
; there is none (HL is then at the variables).
LINEAT: CALL LINE_ADDR
        LD A,(HL)
        CP $40
        CCF
        RET

; FIRSTGE: HL = the number of the first line numbered HL or more; carry if
; there is none.
FIRSTGE:
        CALL LINEAT
        RET C
        LD A,(HL)
        INC HL
        LD L,(HL)
        LD H,A
        AND A
        RET

; LASTLT: HL = the number of the last line numbered below HL; carry if
; there is none.
LASTLT: CALL LINE_ADDR      ; DE: the line before, or PROG
        PUSH DE
        LD DE,(PROG)
        AND A
        SBC HL,DE
        POP HL
        SCF
        RET Z               ; the first line found is the first line
        LD A,(HL)
        INC HL
        LD L,(HL)
        LD H,A
        AND A
        RET

; ISKEYSLOT: Z if HL is SLOT. ISKEYEND: Z if HL is ENDKEY. ISPROG: carry if
; HL is a program line's number.
ISKEYSLOT:
        LD A,H
        AND L
        INC A
        RET
ISKEYEND:
        LD A,H
        CP HIGH ENDKEY
        RET NZ
        LD A,L
        CP LOW ENDKEY
        RET
; CURPROG: HL = the current line, carry if it is a line of the program.
CURPROG:
        LD HL,(CURLINE)
        ; fall into ISPROG
ISPROG: LD A,H
        CP HIGH SLOTEND
        RET

; NEXTKEY: HL = the key after key HL, ENDKEY at the end.
NEXTKEY:
        CALL ISKEYEND
        RET Z
        CALL ISKEYSLOT
        JR NZ,NK1
        LD HL,(SLOTBEF)
        CALL FIRSTGE
        RET NC
        LD HL,ENDKEY
        RET
NK1:    PUSH HL             ; line n: the line after it, m
        CALL NEXTNUM
        POP DE              ; DE: n
        JR NC,NK2
        LD HL,(SLOTBEF)     ; no m: the new line if it is after n
        EX DE,HL
        AND A
        SBC HL,DE           ; n - SLOTBEF: carry if n < SLOTBEF
        LD HL,SLOT
        RET C
        LD HL,ENDKEY
        RET
NK2:    PUSH HL             ; the new line if n < SLOTBEF <= m
        LD HL,(SLOTBEF)
        EX DE,HL
        AND A
        SBC HL,DE           ; n - SLOTBEF
        POP HL
        RET NC
        PUSH HL
        LD DE,(SLOTBEF)
        AND A
        SBC HL,DE           ; m - SLOTBEF
        POP HL
        RET C
        LD HL,SLOT
        RET

; NEXTNUM: HL = the number of the first line after line HL; carry if
; there is none. While the listing is drawn, the line after the one just
; drawn is known without a search.
NEXTNUM:
        LD A,(CACHEOK)
        AND A
        JR Z,NN1
        PUSH HL
        LD DE,(CACHEFROM)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,NN1
        LD HL,(CACHEKEY)
        LD A,(CACHENONE)
        RRA
        RET
NN1:    INC HL
        JP FIRSTGE

; PREVKEY: HL = the key before key HL; carry if there is none.
PREVKEY:
        CALL ISKEYSLOT
        JR NZ,PK1
        LD HL,(SLOTBEF)     ; the new line: the last line before SLOTBEF
        JP LASTLT
PK1:    CALL ISKEYEND
        JR NZ,PK3
        LD HL,SLOTEND       ; the end: the last line, or the new line after it
        CALL LASTLT
        JR C,PK2
        PUSH HL
        LD DE,(SLOTBEF)
        EX DE,HL
        SCF
        SBC HL,DE           ; SLOTBEF - last - 1: no carry if the new line is later
        POP HL
        JR NC,PK2
        AND A
        RET
PK2:    LD HL,SLOT
        AND A
        RET
PK3:    PUSH HL             ; line n: p, the last line before it
        CALL LASTLT
        POP DE              ; DE: n
        PUSH AF
        PUSH HL
        LD HL,(SLOTBEF)
        EX DE,HL
        AND A
        SBC HL,DE           ; n - SLOTBEF: carry if the new line is after n
        POP HL
        JR C,PK4
        POP AF
        JR C,PK2            ; SLOTBEF <= n, no p: the new line
        PUSH HL
        LD DE,(SLOTBEF)
        AND A
        SBC HL,DE           ; p - SLOTBEF: carry if p < SLOTBEF
        POP HL
        JR C,PK2
        AND A
        RET
PK4:    POP AF
        RET

; ORDKEY: HL = a number giving key HL's place in the listing, for
; comparing: 2n+1 for line n, 2*SLOTBEF for the new line, $FFFF for the end.
ORDKEY: CALL ISKEYEND
        JR NZ,OK1
        LD HL,$FFFF
        RET
OK1:    CALL ISKEYSLOT
        JR NZ,OK2
        LD HL,(SLOTBEF)
        ADD HL,HL
        RET
OK2:    ADD HL,HL
        INC HL
        RET

; KEYADDR: HL = the address of program line HL, which must be there.
KEYADDR:
        JP LINE_ADDR

; ---------------------------------------------------------------------------
; The current line
; ---------------------------------------------------------------------------

; SETCUR: line HL becomes the current line: its text into EDBUF, the
; cursor at its start (or after the number auto gives a new line). The
; current line is drawn from EDBUF, so a line whose text has a space LIST
; leaves out (one typed before a keyword) is drawn with it while it is
; current, and as LIST shows it once it is not: either way the listing is
; drawn again (NEEDALL), so that the cursor is where its text is.
SETCUR: LD (CURLINE),HL
        LD A,(CURDIFF)
        AND A
        JR Z,SC0
        CALL NEEDALLON
SC0:    XOR A
        LD (CURDIFF),A
        LD (MODIFIED),A
        LD (READONLY),A
        LD HL,$FFFF
        LD (ERRIDX),HL
        LD HL,0
        LD (CURIDX),HL
        LD (EDLEN),HL
        LD HL,(CURLINE)
        CALL ISKEYSLOT
        JR Z,SC2
        CALL ISPROG
        JR NC,SC1
        CALL KEYADDR
        LD DE,EDBUF
        LD BC,EDMAX
        CALL CAPTURE
        LD (EDLEN),HL
        LD A,(CAPFULL)
        LD (READONLY),A
        AND A
        JR NZ,SC5
        LD A,(CAPDIFF)
        LD (CURDIFF),A
        AND A
        JR Z,SC1
        LD (NEEDALL),A
        JR SC1
SC5:    LD HL,0             ; too long to edit: nothing of it in EDBUF
        LD (EDLEN),HL
SC1:    JP MEASURECUR
SC2:    LD A,(AUTOON)       ; the new line: the next auto number in it
        AND A
        JR Z,SC1
        LD HL,(AUTONEXT)
        CALL NUMTEXT        ; DIGITS
        LD HL,DIGITS
        LD DE,EDBUF
SC3:    LD A,(HL)
        AND A
        JR Z,SC4
        LD (DE),A
        INC HL
        INC DE
        JR SC3
SC4:    LD A,' '
        LD (DE),A
        INC DE
        EX DE,HL
        LD DE,EDBUF
        AND A
        SBC HL,DE
        LD (EDLEN),HL
        LD (CURIDX),HL
        JR SC1

; SETCURKEEP: the current line again, as it now is in the program, the
; cursor kept where it was if the line is still as long.
SETCURKEEP:
        LD HL,(CURIDX)
        PUSH HL
        LD HL,(CURLINE)
        CALL SETCUR
        POP HL
        LD DE,(EDLEN)
        PUSH HL
        AND A
        SBC HL,DE
        POP HL
        RET NC
        LD (CURIDX),HL
        JP MEASURECUR

; VIEWFIX: after the program may have changed under the editor: the
; current line and the top line made ones that are there.
VIEWFIX:
        CALL CURPROG
        JR NC,TOPFIX
        CALL LINE_ADDR      ; Z if it is there
        JR Z,TOPFIX
        LD HL,SLOT          ; gone: the new line, where it was
        LD (CURLINE),HL
        ; fall into TOPFIX

; TOPFIX: the top line made one that is there. A line no longer in the
; program gives way to the first line after it, or to the new line if
; there is none; so does the end of the listing. A top line that is there
; keeps its place, rows hidden above and all.
TOPFIX: LD HL,(TOPLINE)
        CALL ISPROG
        JR NC,VF2
        PUSH HL
        CALL LINE_ADDR
        POP HL
        RET Z               ; it is there
        CALL FIRSTGE
        JR NC,VF3
        LD HL,SLOT
VF3:    LD (TOPLINE),HL
        XOR A
        LD (TOPSKIP),A
VF2:    LD HL,(TOPLINE)
        CALL ISKEYEND
        RET NZ
        LD HL,SLOT
        LD (TOPLINE),HL
        XOR A
        LD (TOPSKIP),A
        RET

; LEAVE: before the cursor leaves the current line. A changed line with a
; number goes into the program; a changed line without one may not be
; left, since it would be lost (ENTER runs it, BREAK puts it back). An
; empty new line goes back to the end of the listing, and so does a
; number alone, which takes its line out: the cursor is then on the new
; line, and LEFTSLOT says which lines were either side of it. Z if the
; cursor may go; NEEDALL is set when the listing has to be drawn again.
LEAVE:  XOR A
        LD (LEFTSLOT),A
        LD HL,(CURLINE)
        CALL ISKEYSLOT
        LD A,0
        JR NZ,LV0
        INC A
LV0:    LD (WASSLOT),A
        LD A,(MODIFIED)
        AND A
        JR Z,LV2
        CALL ISBLANK
        JR Z,LV2
        CALL HASNUMBER
        JR NZ,LV8
        CALL CHECKLINE
        RET NZ              ; refused: the mistake is marked
        LD A,B
        OR C
        JR NZ,LV1
LV8:    LD HL,M_NONUMBER    ; no number, or 0, which the ROM runs as a command
        JP MESSAGE
LV1:    CALL STORELINE
        RET NZ
        LD A,(WASSLOT)      ; from the new line: auto goes on after it, as
        AND A               ; after ENTER
        JR Z,LV7
        LD H,B
        LD L,C
        CALL AUTOAFTER
LV7:    PUSH BC
        LD H,B
        LD L,C
        CALL LINE_ADDR
        POP BC
        JR NZ,LV5           ; a number alone: the line is not there
        LD (CURLINE),BC     ; the cursor is now on the line as entered
        CALL NEEDALLON
        LD A,(WASSLOT)
        AND A
        JR Z,LV3
        LD HL,SLOTEND       ; the new line, now in the program, starts again at the end
        LD (SLOTBEF),HL
        JR LV3
LV5:    INC BC              ; an empty new line where the line was, left
        LD (SLOTBEF),BC
        LD HL,SLOT
        CALL SETCUR
        JR LV6
LV2:    LD A,(WASSLOT)
        AND A
        JR Z,LV3
LV6:    LD HL,(SLOTBEF)     ; the new line, left empty, goes back to the end
        LD A,H
        CP HIGH SLOTEND
        JR Z,LV3
        CALL LASTLT         ; noting the lines it was between, for up and down
        LD (SLOTPREV),HL
        LD A,0
        RLA
        LD (SLOTPNONE),A
        LD HL,(SLOTBEF)
        CALL FIRSTGE
        JR NC,LV4
        LD HL,SLOT
LV4:    LD (SLOTNEXT),HL
        LD A,1
        LD (LEFTSLOT),A
        LD HL,SLOTEND
        LD (SLOTBEF),HL
        CALL NEEDALLON
LV3:    XOR A
        RET

; ISBLANK: Z if EDBUF has nothing but spaces.
ISBLANK:
        LD HL,EDBUF
        LD BC,(EDLEN)
IBL1:   LD A,B
        OR C
        RET Z
        LD A,(HL)
        CP ' '
        RET NZ
        INC HL
        DEC BC
        JR IBL1

; HASNUMBER: Z if EDBUF starts, after any spaces, with a digit.
HASNUMBER:
        LD HL,EDBUF
        LD BC,(EDLEN)
HN1:    LD A,B
        OR C
        JR Z,HN2
        LD A,(HL)
        INC HL
        DEC BC
        CP ' '
        JR Z,HN1
        CP '0'
        JR C,HN2
        CP '9'+1
        JR NC,HN2
        CP A
        RET
HN2:    OR 1
        RET

; ---------------------------------------------------------------------------
; Drawing the listing
; ---------------------------------------------------------------------------

; RENDERALL: the whole listing drawn from the top line.
RENDERALL:
        LD A,(TOPSKIP)
        NEG
        LD B,A
        LD HL,(TOPLINE)
        ; fall into RENDERFROM

; RENDERFROM: from screen row B (signed: it may be above the screen) down,
; starting with line HL: the lines drawn, the rows after the last one
; emptied, and ROWMAP filled in. While it draws, the address of the line
; after each one drawn is kept (CACHEKEY), so that the next one is found
; without searching the program from its start.
RENDERFROM:
        XOR A
        LD (CACHEOK),A
        CALL RF1
        XOR A
        LD (CACHEOK),A
        RET
RF1:    LD A,B
        BIT 7,A
        JR NZ,RF2
        CP ROWS
        RET NC              ; past the bottom
RF2:    CALL ISKEYEND
        JR Z,RFEND
        PUSH HL
        PUSH BC
        LD A,B
        CALL DRAWKEY        ; A: the rows it took
        POP BC
        POP HL
        LD (ROWSCOUNT),A
        CALL MAPROWS        ; ROWMAP for its rows on the screen
        LD A,(ROWSCOUNT)
        ADD A,B
        LD B,A
        PUSH BC
        CALL NEXTKEY        ; which uses BC
        POP BC
        JR RF1
RFEND:  LD A,B              ; the end: the rows after it emptied
        BIT 7,A
        JR Z,RFE0
        XOR A
RFE0:   PUSH HL
        PUSH BC
        LD C,A
        CALL CLEARFROM
        POP BC
        POP HL
        LD A,0              ; and the rest of ROWMAP is the end
        LD (ROWSCOUNT),A
RFE1:   LD A,B
        BIT 7,A
        JR NZ,RFE2
        CP ROWS
        RET NC
        PUSH BC
        LD C,0
        CALL MAPONE
        POP BC
RFE2:   INC B
        JR RFE1

; MAPROWS: ROWMAP rows B to B+ROWSCOUNT-1 that are on the screen get key HL.
MAPROWS:
        PUSH BC
        LD C,0              ; the row within the line
        LD A,(ROWSCOUNT)
        LD E,A
MR1:    LD A,E
        AND A
        JR Z,MR3
        LD A,B
        BIT 7,A
        JR NZ,MR2
        CP ROWS
        JR NC,MR3
        CALL MAPONE
MR2:    INC B
        INC C
        DEC E
        JR MR1
MR3:    POP BC
        RET

; MAPONE: ROWMAP row B = key HL, row C of it.
MAPONE: PUSH HL
        PUSH DE
        PUSH AF
        PUSH HL
        LD A,B
        CALL MAPADDR
        POP DE
        LD (HL),E
        INC HL
        LD (HL),D
        INC HL
        LD (HL),C
        POP AF
        POP DE
        POP HL
        RET

; MAPADDR: HL = where screen row A is in ROWMAP; DE is changed.
MAPADDR:
        LD L,A
        LD H,0
        LD D,H
        LD E,L
        ADD HL,HL
        ADD HL,DE
        LD DE,ROWMAP
        ADD HL,DE
        RET

; ROWKEY: HL = the key on screen row A, and C its row within the line.
ROWKEY: CALL MAPADDR
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        LD C,(HL)
        EX DE,HL
        RET

; DRAWKEY: line HL drawn from screen row A (signed), clipped to the
; listing rows; A = the rows it takes.
DRAWKEY:
        LD B,A
        XOR A
        LD (CLIPLO),A
        LD A,ROWS-1
        LD (CLIPHI),A
        LD A,B
DRAWKEYCLIP:
        PUSH HL
        LD DE,(CURLINE)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,DK1
        LD (CURTOP),A       ; the current line, from EDBUF
        LD B,A
        LD A,(READONLY)
        AND A
        LD A,B
        JR NZ,DK1           ; too long to edit: from the program
        XOR A
        LD (DRAWMODE),A
        LD A,B
        CALL DRAWEDBUF
        LD A,(CURROWS)
        RET
DK1:    LD (DRAWSTART),A
        CALL ISKEYSLOT
        JR NZ,DK2
        LD A,(DRAWSTART)    ; the new line, not current: an empty row
        CALL INCLIP
        JR NC,DK1B
        LD A,(DRAWSTART)
        LD C,A
        CALL CLEARROW
DK1B:   LD A,1
        RET
DK2:    LD A,(CACHEOK)      ; the line after the one just drawn: its address is known
        AND A
        JR Z,DK3
        LD A,(CACHENONE)
        AND A
        JR NZ,DK3
        PUSH HL
        LD DE,(CACHEKEY)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,DK3
        LD HL,(CACHEADDR)
        JR DK4
DK3:    CALL KEYADDR        ; which uses BC
DK4:    PUSH HL
        XOR A
        LD (DRAWMODE),A
        LD A,(DRAWSTART)
        CALL DRAWLINE
        POP HL
        PUSH AF
        CALL CACHENEXT
        POP AF
        RET

; CACHENEXT: after the line at HL is drawn, the line after it noted: its
; number and address, or that there is none.
CACHENEXT:
        LD D,(HL)
        INC HL
        LD E,(HL)
        LD (CACHEFROM),DE
        INC HL
        LD C,(HL)
        INC HL
        LD B,(HL)
        INC HL
        ADD HL,BC
        LD (CACHEADDR),HL
        LD A,(HL)
        CP $40
        LD A,1
        JR NC,CN1           ; past the last line
        LD D,(HL)
        INC HL
        LD E,(HL)
        LD (CACHEKEY),DE
        XOR A
CN1:    LD (CACHENONE),A
        LD A,1
        LD (CACHEOK),A
        RET

; ROWSOF: A = the rows line HL takes.
ROWSOF: PUSH HL
        LD DE,(CURLINE)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,RO1
        LD A,(CURROWS)
        RET
RO1:    CALL ISKEYSLOT
        LD A,1
        RET Z
        CALL KEYADDR
        LD A,1
        LD (DRAWMODE),A
        XOR A
        JP DRAWLINE

; BACKWALK: from row C of line HL, SCROLLN rows up: HL and C give where
; that is, or the top of the listing if it is nearer.
BACKWALK:
        LD A,(SCROLLN)
        LD B,A
        LD A,C
        SUB B
        JR C,BW1
        LD C,A              ; within the same line
        RET
BW1:    NEG
        LD (SCROLLN),A      ; rows still to go
BW2:    PUSH HL
        CALL PREVKEY
        JR C,BW4            ; the top
        POP DE
        PUSH HL
        CALL ROWSOF
        POP HL
        LD B,A
        LD A,(SCROLLN)
        LD C,A
        LD A,B
        SUB C               ; rows - still to go
        JR C,BW3
        LD C,A
        RET
BW3:    NEG
        LD (SCROLLN),A
        JR BW2
BW4:    POP HL
        LD C,0
        RET

; MEASURECUR: CURROWS, CURSUB and CURCOL for EDBUF as it stands.
MEASURECUR:
        LD A,(READONLY)
        AND A
        JR NZ,MC1
        LD A,1
        LD (DRAWMODE),A
        XOR A
        JP DRAWEDBUF
MC1:    XOR A               ; a line too long to edit: the cursor at its start,
        LD (CURSUB),A       ; and its rows as it is listed
        LD (CURCOL),A
        LD H,A
        LD L,A
        LD (WANTIDX),HL
        LD HL,(CURLINE)
        CALL KEYADDR
        LD A,1
        LD (DRAWMODE),A
        XOR A
        CALL DRAWLINE
        LD (CURROWS),A
        RET

; LOCATEROW: LOCATE, for row A of the line and column COLWANT.
LOCATEROW:
        LD (WANTROW),A
        LD A,(COLWANT)
        LD (WANTCOL),A
        ; fall into LOCATE

; LOCATE: CURIDX = the place in EDBUF nearest to row WANTROW, column
; WANTCOL of the line, at or before it; on a new line that holds only the
; number auto gave it, after the number.
LOCATE: LD A,1
        LD (DRAWMODE),A
        XOR A
        CALL DRAWEDBUF
        LD HL,(WANTIDX)
        LD (CURIDX),HL
        CALL ISAUTOSLOT
        JP NZ,MEASURECUR
        LD HL,(EDLEN)
        LD (CURIDX),HL
        JP MEASURECUR

; ISAUTOSLOT: Z if the current line is the new line, with only the number
; auto gave it.
ISAUTOSLOT:
        LD A,(AUTOON)
        AND A
        JR Z,IAS1
        LD A,(MODIFIED)
        AND A
        RET NZ
        LD HL,(CURLINE)
        JP ISKEYSLOT
IAS1:   OR 1
        RET

; FINDCURTOP: CURTOP from ROWMAP; carry if the current line is not on
; the screen.
FINDCURTOP:
        LD B,0
FC1:    LD A,B
        PUSH BC
        CALL ROWKEY
        LD DE,(CURLINE)
        AND A
        SBC HL,DE
        LD A,C
        POP BC
        JR Z,FC2
        INC B
        LD A,B
        CP ROWS
        JR C,FC1
        SCF
        RET
FC2:    LD C,A
        LD A,B
        SUB C
        LD (CURTOP),A
        AND A
        RET

; PLACECUR: the cursor put where CURIDX is, the listing scrolled if it is
; off the screen.
PLACECUR:
        CALL MEASURECUR
        ; fall into ENSUREVIS

; ENSUREVIS: the listing moved, if it has to be, so that the cursor is on
; the screen; CXROW and CXCOL set.
ENSUREVIS:
        XOR A
        LD (EVGUARD),A
EVLOOP: CALL FINDCURTOP
        JR C,EV3
        LD A,(CURSUB)
        LD B,A
        LD A,(CURTOP)
        ADD A,B             ; the cursor's screen row
        BIT 7,A
        JR NZ,EV2           ; above
        CP ROWS
        JR C,EV1            ; on the screen
        SUB ROWS-1          ; below: rows to scroll up
        CP 4
        JR NC,EV4
        LD B,A
EVU:    PUSH BC
        CALL SCROLLUP
        POP BC
        DJNZ EVU
        JR EVLOOP
EV1:    PUSH AF
        CALL FILLVIEW       ; NZ if the listing moved to fill the screen
        POP BC
        JR NZ,EVLOOP
        LD A,B
        LD (CXROW),A
        LD A,(CURCOL)
        LD (CXCOL),A
        RET
EV2:    NEG                 ; rows to scroll down
        CP 4
        JR NC,EV5
        LD B,A
EVD:    PUSH BC
        CALL SCROLLDOWN
        POP BC
        DJNZ EVD
        JR EVLOOP
EV3:    LD HL,(CURLINE)     ; not on the screen at all: above or below?
        CALL ORDKEY
        PUSH HL
        LD HL,(TOPLINE)
        CALL ORDKEY
        POP DE
        AND A
        SBC HL,DE           ; top - cursor's line: no carry if it is above
        JR C,EV4
EV5:    LD HL,(CURLINE)     ; the cursor's row at the top
        LD (TOPLINE),HL
        LD A,(CURSUB)
        LD (TOPSKIP),A
        JR EV6
EV4:    LD HL,(CURLINE)     ; the cursor's row at the bottom
        LD A,(CURSUB)
        LD C,A
        LD A,ROWS-1
        LD (SCROLLN),A
        CALL BACKWALK
        LD (TOPLINE),HL
        LD A,C
        LD (TOPSKIP),A
EV6:    LD HL,EVGUARD
        INC (HL)
        LD A,(HL)
        CP 3
        JR NC,EV7           ; it cannot be shown: no cursor
        CALL RENDERALL
        JP EVLOOP
EV7:    LD A,$FF
        LD (CXROW),A
        RET

; FILLVIEW: if the listing ends above the bottom of the screen while
; there is more of it above the top, it is moved down to fill the screen.
; NZ if it was drawn again.
FILLVIEW:
        LD A,(EVGUARD)
        CP 2
        JR NC,FV9           ; it has moved enough
        LD B,0              ; the empty rows at the bottom
        LD A,ROWS-1
FV1:    PUSH AF
        PUSH BC
        CALL ROWKEY
        CALL ISKEYEND
        POP BC
        JR NZ,FV2
        INC B
        POP AF
        DEC A
        JP P,FV1
        JR FV3
FV2:    POP AF
FV3:    LD A,B
        AND A
        JR Z,FV9
        LD (SCROLLN),A
        LD HL,(TOPLINE)
        LD A,(TOPSKIP)
        LD C,A
        PUSH HL
        PUSH BC
        CALL BACKWALK
        POP DE              ; E: the old TOPSKIP
        EX (SP),HL          ; HL: the old top, the new one kept
        POP DE              ; DE: the new top
        PUSH DE
        AND A
        SBC HL,DE
        POP HL
        JR NZ,FV4
        LD A,(TOPSKIP)
        CP C
        JR Z,FV9            ; the top already
FV4:    LD (TOPLINE),HL
        LD A,C
        LD (TOPSKIP),A
        LD HL,EVGUARD
        INC (HL)
        CALL RENDERALL
        OR 1
        RET
FV9:    XOR A
        RET

; REDRAWCUR: the current line drawn again after a change to it; the lines
; below too if it now takes a different number of rows.
REDRAWCUR:
        LD A,(READONLY)
        AND A
        JP NZ,ENSUREVIS     ; a line too long to edit has not changed
        LD A,(CURROWS)
        PUSH AF
        CALL MEASURECUR
        CALL FINDCURTOP
        POP BC              ; B: the rows it took
        JR C,RC2            ; not on the screen
        LD A,(CURROWS)
        CP B
        JR NZ,RC1
        XOR A               ; as many rows: only its own rows
        LD (CLIPLO),A
        LD A,ROWS-1
        LD (CLIPHI),A
        XOR A
        LD (DRAWMODE),A
        LD A,(CURTOP)
        CALL DRAWEDBUF
        JP ENSUREVIS
RC1:    LD A,(CURTOP)
        LD B,A
        LD HL,(CURLINE)
        CALL RENDERFROM
RC2:    JP ENSUREVIS

; SCROLLUP: the listing one row up, the row at the bottom drawn new.
SCROLLUP:
        LD A,ROWS-1
        CALL ROWKEY         ; the bottom row's line and its row in it
        CALL ISKEYEND
        RET Z               ; nothing below
        PUSH HL
        PUSH BC
        CALL ROWSOF
        POP BC
        POP HL
        INC C
        CP C
        JR Z,SU1
        JR NC,SU2           ; more of the same line
SU1:    CALL NEXTKEY        ; the next line
        LD C,0
SU2:    PUSH HL
        PUSH BC
        CALL PIXUP
        LD HL,ROWMAP+3      ; ROWMAP up a row
        LD DE,ROWMAP
        LD BC,(ROWS-1)*3
        LDIR
        POP BC
        POP HL
        LD B,ROWS-1
        CALL MAPONE
        CALL TOPFROMMAP
        CALL ISKEYEND
        RET Z
        LD A,ROWS-1
        LD (CLIPLO),A
        LD (CLIPHI),A
        SUB C               ; where the line starts
        JP DRAWKEYCLIP

; SCROLLDOWN: the listing one row down, the row at the top drawn new.
SCROLLDOWN:
        XOR A
        CALL ROWKEY
        LD A,C
        AND A
        JR Z,SD1
        DEC C               ; more of the same line above
        JR SD2
SD1:    CALL PREVKEY
        RET C               ; the top already
        PUSH HL
        CALL ROWSOF
        POP HL
        DEC A
        LD C,A
SD2:    PUSH HL
        PUSH BC
        CALL PIXDOWN
        LD HL,ROWMAP+((ROWS-1)*3)-1
        LD DE,ROWMAP+(ROWS*3)-1
        LD BC,(ROWS-1)*3
        LDDR
        POP BC
        POP HL
        LD B,0
        CALL MAPONE
        CALL TOPFROMMAP
        XOR A
        LD (CLIPLO),A
        LD (CLIPHI),A
        SUB C
        JP DRAWKEYCLIP

; TOPFROMMAP: TOPLINE and TOPSKIP from ROWMAP's first row.
TOPFROMMAP:
        PUSH HL
        PUSH BC
        XOR A
        CALL ROWKEY
        LD (TOPLINE),HL
        LD A,C
        LD (TOPSKIP),A
        POP BC
        POP HL
        RET

; ---------------------------------------------------------------------------
; The status row
; ---------------------------------------------------------------------------
;
; Row 23 shows a message if there is one, or the report of what last ran
; if it printed nothing, or else the line under the cursor and the modes.

STATUS: CALL BEGINOUT
        LD A,ROWS
        LD (DRAWROW),A
        LD (CLIPLO),A
        LD (CLIPHI),A
        XOR A
        LD (DRAWCOL),A
        LD (DRAWMODE),A
        LD (PARAMS),A
        CALL BEGINROW
        LD HL,(MSGPTR)
        LD A,H
        OR L
        JR Z,ST1
        DEC HL
        LD A,H
        OR L
        INC HL
        JR Z,ST0
        CALL PRINTSTR
        JP STEND
ST0:    CALL PRINTREFUSED   ; MSGPTR 1: the ROM's report for a refused line
        JP STEND
ST1:    LD HL,EDFLAGS
        BIT 1,(HL)
        JR Z,ST2
        CALL PRINTREPORT
        JP STEND
ST2:    CALL CURPROG
        JR NC,ST3
        PUSH HL
        LD HL,S_LINE
        CALL PRINTSTR
        POP HL
        LD DE,LNDIGITS      ; written out in full, as OUT-NUM-1 cannot past 9999
        CALL NUMTEXTAT
        LD HL,LNDIGITS
        CALL CHOUTZ
        JR ST4
ST3:    LD HL,S_NEWLINE
        CALL PRINTSTR
ST4:    LD A,12
        CALL TOCOL
        LD HL,S_INS
        LD A,(INSMODE)
        AND A
        JR NZ,ST5
        LD HL,S_OVR
ST5:    CALL PRINTSTR
        LD A,(FLAGS2)
        AND $08
        LD HL,S_CAPS
        CALL NZ,PRINTSTR
        LD A,(MODE)
        CP 2
        LD HL,S_GRAPH
        CALL Z,PRINTSTR
        LD A,(AUTOON)
        AND A
        LD HL,S_AUTO
        CALL NZ,PRINTSTR
        LD A,(EXTPEND)
        AND A
        LD HL,S_EXTEND
        CALL NZ,PRINTSTR
        LD A,36
        CALL TOCOL
        LD HL,S_EDITOR
        CALL PRINTSTR
        JP STEND

; STEND: the status row drawn, and the channel as it was.
STEND:  CALL FLUSHROW
        JP ENDOUT

; TOCOL: spaces up to column A of the row being drawn.
TOCOL:  LD HL,DRAWCOL
        CP (HL)
        RET C
        RET Z
        PUSH AF
        LD A,' '
        RST $10
        POP AF
        JR TOCOL

; PRINTSTR: the text at HL, its last character with bit 7 set, through
; the current channel.
PRINTSTR:
        LD A,(HL)
        AND $7F
        PUSH HL
        CP 1
        JR NZ,PS1
        LD HL,DIGITS        ; character 1: the number in DIGITS
        CALL CHOUTZ
        JR PS2
PS1:    RST $10
PS2:    POP HL
        BIT 7,(HL)
        INC HL
        JR Z,PRINTSTR
        RET

; PRINTREFUSED: the report the ROM gave for a line it refused, such as
; C Nonsense in BASIC.
PRINTREFUSED:
        LD A,(LASTERR)
        INC A
        LD B,A
        CP 10
        JR C,PF1
        ADD A,7
PF1:    ADD A,'0'
        PUSH BC
        RST $10
        LD A,' '
        RST $10
        POP BC
        LD A,B
        LD DE,REPORTS
        JP PO_MSG

; PRINTREPORT: the report of what last ran, as the ROM printed it, such as
; 0 OK, 10:1.
PRINTREPORT:
        LD A,(LASTERR)
        INC A
        LD B,A
        CP 10
        JR C,PR1
        ADD A,7
PR1:    ADD A,'0'
        PUSH BC
        RST $10
        LD A,' '
        RST $10
        POP BC
        PUSH BC
        LD A,B
        LD DE,REPORTS
        CALL PO_MSG
        XOR A
        LD DE,COMMA_MSG
        CALL PO_MSG
        LD BC,(PPC)
        CALL OUT_NUM_1
        LD A,':'
        RST $10
        POP BC
        LD A,(SUBPPC)
        LD C,A
        LD A,B
        CP 9                ; STOP and BREAK: MAIN-4 adds 1 after printing
        JR Z,PR2
        CP $15
        JR NZ,PR3
PR2:    DEC C
PR3:    LD B,0
        JP OUT_NUM_1

; MESSAGE: message HL on the status row until the next key; NZ.
MESSAGE:
        LD (MSGPTR),HL
        CALL STATUS
        OR 1
        RET

; ---------------------------------------------------------------------------
; The listing and the channel
; ---------------------------------------------------------------------------
;
; CHOUT takes the listing a character at a time: from NATLIST for a line
; of the program, from DRAWEDBUF for the line being edited, and through
; RST $10, with CURCHL pointing at CHREC, from the ROM's PO-MSG and
; OUT-NUM-1 and PRINTSTR for the status row. It draws (DRAWMODE 0), only
; counts where each character would go (1), or keeps the characters as the
; text of the line (2, capture). CURCHL points at CHREC only between
; BEGINOUT and ENDOUT: POINTERS would move it, as it lies above the
; program, if anything were inserted meanwhile.

CHREC:  DW CHOUT            ; output
        DW $15C4            ; input: REPORT-J, as the ROM's output-only channels
        DB 'X'

; BEGINOUT: the editor's channel made current, for RST $10.
BEGINOUT:
        LD HL,(CURCHL)
        LD (SAVECHL),HL
        LD HL,CHREC
        LD (CURCHL),HL
        RET

; ENDOUT: the channel as it was before BEGINOUT.
ENDOUT: LD HL,(SAVECHL)
        LD (CURCHL),HL
        RET

; DRAWLINE: the program line at HL through CHOUT, in DRAWMODE, from screen
; row A; A = the rows it takes.
DRAWLINE:
        LD (DRAWSTART),A
        LD (DRAWROW),A
        XOR A
        LD (DRAWCOL),A
        LD (PARAMS),A
        LD (REMSEEN),A
        LD (EXPANDING),A
        LD (DRAWINV),A
        LD A,(DRAWMODE)
        AND A
        PUSH HL
        CALL Z,BEGINROW
        POP HL
        CALL NATLIST        ; the line, as LIST shows it
        CALL FLUSHROW
        LD A,(DRAWSTART)
        LD B,A
        LD A,(DRAWROW)
        SUB B
        INC A
        RET

; NATLIST: the program line at HL through CHOUT, as the ROM's OUT-LINE
; lists it: the number in 4 columns, then every byte but the hidden forms
; of the numbers, with FLAGS2 bit 2 set between quotes as OUT-CHAR keeps it.
NATLIST:
        LD B,(HL)
        INC HL
        LD C,(HL)
        INC HL
        INC HL
        INC HL
        PUSH HL
        LD H,B
        LD L,C
        CALL OUTNUM4
        POP HL
        RES 0,(IY+1)        ; FLAGS: no space before the first keyword yet
        RES 2,(IY+48)       ; FLAGS2: not in quotes
NL1:    LD A,(HL)
        CP $0D
        RET Z
        CP $0E
        JR NZ,NL2
        LD DE,6             ; a number's hidden form
        ADD HL,DE
        JR NL1
NL2:    CP '"'
        JR NZ,NL3
        LD A,(FLAGS2)
        XOR $04
        LD (FLAGS2),A
        LD A,'"'
NL3:    PUSH HL
        CALL CHOUT
        POP HL
        INC HL
        JR NL1

; OUTNUM4: the number HL through CHOUT, right-aligned in 4 columns as
; OUT-NUM-2 writes a line number.
OUTNUM4:
        LD DE,LNDIGITS      ; not DIGITS, which may hold a number for a message
        CALL NUMTEXTAT
        LD HL,LNDIGITS
        LD B,0
OU1:    LD A,(HL)
        AND A
        JR Z,OU2
        INC HL
        INC B
        JR OU1
OU2:    LD A,4
        SUB B
        JR C,OU4
        JR Z,OU4
        LD B,A
OU3:    PUSH BC
        LD A,' '
        CALL CHOUT
        POP BC
        DJNZ OU3
OU4:    LD HL,LNDIGITS
CHOUTZ: LD A,(HL)           ; the 0-ended text at HL through CHOUT
        AND A
        RET Z
        PUSH HL
        CALL CHOUT
        POP HL
        INC HL
        JR CHOUTZ

; CAPTURE: the text of the program line at HL, as LIST shows it, into the
; buffer at DE, at most BC bytes; HL = its length. Keywords come as their
; letters, but those inside quotes and after REM stay as tokens, as
; typing them in the ROM's editor made them, and a space typed next to a
; keyword is kept, so that the text gives back the same bytes. A space
; typed before a keyword that LIST puts a space before is then followed by
; that space too, one more than LIST shows: CAPDIFF says so.
CAPTURE:
        LD (CAPPTR),DE
        PUSH DE
        EX DE,HL
        ADD HL,BC
        LD (CAPLIM),HL
        EX DE,HL
        LD A,2
        LD (DRAWMODE),A
        XOR A
        LD (CAPFULL),A
        LD (CAPDIFF),A
        CALL DRAWLINE
        POP DE
        LD HL,(CAPPTR)
        AND A
        SBC HL,DE
        RET

; DRAWEDBUF: EDBUF through CHOUT, in DRAWMODE, from screen row A (0 for
; measuring). Gives CURSUB and CURCOL for the cursor at CURIDX, CURROWS,
; and WANTIDX for the place nearest WANTROW and WANTCOL.
DRAWEDBUF:
        LD (DRAWSTART),A
        LD (DRAWROW),A
        XOR A
        LD (DRAWCOL),A
        LD (PARAMS),A
        LD (EXPANDING),A
        LD (DRAWINV),A
        LD H,A
        LD L,A
        LD (WANTIDX),HL
        RES 0,(IY+1)        ; FLAGS: as OUT-LINE leaves it after the number
        LD A,(DRAWMODE)
        AND A
        CALL Z,BEGINROW
        LD HL,0             ; HL: the place in EDBUF
DE1:    CALL DEPOS          ; where the place is
        LD DE,(EDLEN)
        PUSH HL
        AND A
        SBC HL,DE
        POP HL
        JR NC,DE3           ; the end
        PUSH HL
        LD DE,(ERRIDX)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,DE2
        LD A,1
        LD (DRAWINV),A      ; the mistake: inverse
DE2:    PUSH HL
        LD DE,EDBUF
        ADD HL,DE
        LD A,(HL)
        CALL CHOUT
        XOR A
        LD (DRAWINV),A
        POP HL
        INC HL
        JR DE1
DE3:    CALL FLUSHROW
        LD A,(DRAWSTART)    ; the rows: to the last character, or the cursor
        LD B,A
        LD A,(DRAWROW)
        SUB B
        INC A
        LD B,A
        LD A,(CURSUB)
        INC A
        CP B
        JR C,DE4
        LD B,A
DE4:    LD A,B
        LD (CURROWS),A
        RET

; DEPOS: before place HL is drawn: CURSUB and CURCOL if it is the cursor's,
; and WANTIDX if it is at or before WANTROW, WANTCOL.
DEPOS:  LD A,(DRAWSTART)
        LD B,A
        LD A,(DRAWROW)
        SUB B
        LD B,A              ; the row within the line
        LD A,(DRAWCOL)
        CP COLS
        JR C,DP1
        INC B               ; a full row: the next one starts here
        XOR A
DP1:    LD C,A
        PUSH HL
        LD DE,(CURIDX)
        AND A
        SBC HL,DE
        JR NZ,DP2
        LD A,B
        LD (CURSUB),A
        LD A,C
        LD (CURCOL),A
DP2:    POP HL
        LD A,(WANTROW)
        CP B
        JR C,DP4            ; past the row wanted
        JR NZ,DP3           ; a row before it
        LD A,(WANTCOL)
        CP C
        JR C,DP4            ; past the column
DP3:    LD (WANTIDX),HL
DP4:    RET

; CHOUT: a character of the listing. It may use AF, BC, DE and HL freely:
; RST $10 calls it with the alternate registers in use, and the editor's
; own callers keep what they need.
CHOUT:  LD C,A
        LD A,(PARAMS)
        AND A
        JR Z,CO1
        DEC A               ; a control's number
        LD (PARAMS),A
        LD A,(DRAWMODE)
        CP 2
        LD A,C
        JP Z,COSTORE
        CP 10
        JP C,COCELL         ; a digit 0 to 9
        LD A,$0A            ; anything else: ?
        JP COCELL
CO1:    LD A,C
        CP $10
        JP C,COODD
        CP $18
        JR NC,CO2
        LD B,1              ; INK to OVER: one number to follow
        CP $16
        JR C,CO1A
        INC B               ; AT and TAB: two
CO1A:   LD A,B
        LD (PARAMS),A
        LD A,(DRAWMODE)
        CP 2
        LD A,C
        JP Z,COSTORE
        JP COCELL
CO2:    CP $A5
        JP C,COCHAR
        LD A,(DRAWMODE)     ; a token
        CP 2
        JR NZ,COEXP
        LD A,(FLAGS2)       ; capture: kept as it is in quotes or after REM
        AND $04
        JR NZ,CORAW
        LD A,(REMSEEN)
        AND A
        JR NZ,CORAW
        LD A,C
        CP T_REM
        JR NZ,COEXP
        LD A,1
        LD (REMSEEN),A
COEXP:  LD A,(EXPANDING)    ; its letters, spaced as PO-TOKENS spaces them
        PUSH AF
        LD A,1
        LD (EXPANDING),A
        LD A,C
        LD (EXPTOK),A
        CALL TOKENTRY       ; HL: its text
        LD A,(EXPTOK)       ; a space before one from OR on that starts with a
        CP $C5              ; letter, unless one is there already
        JR C,XP1
        LD A,(HL)
        AND $7F
        CP 'A'
        JR C,XP1
        BIT 0,(IY+1)        ; FLAGS
        JR NZ,XP1
        PUSH HL
        LD A,(DRAWMODE)     ; capture, after a space typed: LIST shows only one
        CP 2
        JR NZ,XP0
        LD HL,(CAPPTR)
        DEC HL
        LD A,(HL)
        CP ' '
        JR NZ,XP0
        LD A,1
        LD (CAPDIFF),A
XP0:    LD A,' '
        CALL CHOUT
        POP HL
XP1:    LD A,(HL)
        AND $7F
        PUSH HL
        CALL CHOUT
        POP HL
        BIT 7,(HL)
        INC HL
        JR Z,XP1
        DEC HL              ; a space after it, but not after RND, INKEY$ or
        LD A,(EXPTOK)       ; PI, nor after one ending below A other than $
        CP $A8
        JR C,XP3
        LD A,(HL)
        AND $7F
        CP '$'
        JR Z,XP2
        CP 'A'
        JR C,XP3
XP2:    LD A,' '
        CALL CHOUT
XP3:    POP AF
        LD (EXPANDING),A
        RET
CORAW:  LD A,C
        JP COSTORE
COODD:  LD A,(DRAWMODE)     ; another code below $10
        CP 2
        LD A,C
        JP Z,COSTORE
        LD A,$0A
        JR COCELL
COCHAR: CP ' '              ; FLAGS bit 0 as PO-CHAR keeps it: set after a
        JR NZ,COC1          ; space, so that a keyword after one needs none
        LD HL,FLAGS
        SET 0,(HL)
        LD A,(DRAWMODE)
        CP 2
        JR NZ,COC3
        LD A,(EXPANDING)    ; capture: a space typed by the user does not
        AND A               ; count, so that it shows as one and is kept
        JR NZ,COC3
        RES 0,(HL)
        JR COC3
COC1:   CP $80
        JR C,COC2
        CP $90
        JR C,COC3           ; a block graphic leaves it, as PO-GR-1 does
COC2:   LD HL,FLAGS
        RES 0,(HL)
COC3:   LD A,(DRAWMODE)
        CP 2
        LD A,C
        JR Z,COSTORE
        ; fall into COCELL

; COCELL: cell code A at DRAWROW, DRAWCOL, which then moves on; a full row
; is drawn, and the next one begun, unless the line has MAXROWS rows
; already: the rest of it is left out.
COCELL: LD C,A
        LD A,(DRAWCOL)
        CP COLS
        JR C,CC1
        LD HL,DRAWSTART
        LD A,(DRAWROW)
        SUB (HL)
        CP MAXROWS-1
        RET NC
        PUSH BC
        CALL FLUSHROW
        POP BC
        XOR A
        LD (DRAWCOL),A
        LD HL,DRAWROW
        INC (HL)
CC1:    LD A,(DRAWMODE)
        AND A
        JR NZ,CC2           ; measuring
        LD A,(DRAWCOL)
        LD E,A
        LD D,0
        LD HL,ROWBUF
        ADD HL,DE
        LD (HL),C
        LD A,(DRAWINV)
        AND A
        JR Z,CC2
        LD A,E
        LD (ROWINV),A
CC2:    LD HL,DRAWCOL
        INC (HL)
        RET

; FLUSHROW: when drawing, the row in ROWBUF written to the screen if it is
; within CLIPLO to CLIPHI, and ROWBUF begun again.
FLUSHROW:
        LD A,(DRAWMODE)
        AND A
        RET NZ
        LD A,(DRAWROW)
        CALL INCLIP
        JR NC,BEGINROW
        LD A,(DRAWROW)
        LD B,A
        CALL BLITROW
        ; fall into BEGINROW

; BEGINROW: ROWBUF all spaces, none inverse.
BEGINROW:
        LD HL,ROWBUF
        LD B,COLS
BR0:    LD (HL),' '
        INC HL
        DJNZ BR0
        LD A,$FF
        LD (ROWINV),A
        RET

; INCLIP: carry if row A (signed) is within CLIPLO to CLIPHI.
INCLIP: XOR $80
        LD E,A
        LD A,(CLIPLO)
        XOR $80
        CP E
        JR Z,IC1
        JR NC,IC2
IC1:    LD A,(CLIPHI)
        XOR $80
        CP E
        JR C,IC2
        SCF
        RET
IC2:    AND A
        RET

; COSTORE: capture: A kept as the next byte of the text.
COSTORE:
        LD HL,(CAPPTR)
        LD DE,(CAPLIM)
        PUSH HL
        AND A
        SBC HL,DE
        POP HL
        JR NC,CS1
        LD (HL),A
        INC HL
        LD (CAPPTR),HL
        RET
CS1:    LD A,1
        LD (CAPFULL),A
        RET

; ---------------------------------------------------------------------------
; Cells
; ---------------------------------------------------------------------------
;
; A cell is 6 pixels wide and 8 high. Its code is a character $20-$7F
; from FONT, a block graphic $80-$8F, a UDG $90-$A4 squeezed into 6
; columns, or below $20 one of these, drawn inverse: $00-$09 the digits,
; $0A ?, $10-$17 i p f b v o @ t for INK, PAPER, FLASH, BRIGHT, INVERSE,
; OVER, AT and TAB.

; GLYPHFOR: GLYPH = cell code A's 8 rows, in bits 7 to 2.
GLYPHFOR:
        CP $20
        JR C,GFCTRL
        CP $80
        JR C,GFFONT
        CP $90
        JR C,GFBLOCK
        CP $A5
        JR C,GFUDG
        LD A,'?'
        JR GFINV
GFCTRL: CP $0A
        JR C,GFDIGIT
        JR Z,GFQ
        CP $10
        JR C,GFQ
        CP $18
        JR NC,GFQ
        SUB $10
        LD E,A
        LD D,0
        LD HL,CTRLNAMES
        ADD HL,DE
        LD A,(HL)
        JR GFINV
GFDIGIT:
        ADD A,'0'
        JR GFINV
GFQ:    LD A,'?'
GFINV:  CALL GFFONT
        ; fall into GLYPHINV

; GLYPHINV: GLYPH inverted, within its 6 columns.
GLYPHINV:
        LD HL,GLYPH
        LD B,8
GI1:    LD A,(HL)
        XOR $FC
        LD (HL),A
        INC HL
        DJNZ GI1
        RET

; GFFONT: character A, $20 to $7F, from FONT, 7 bytes a character.
GFFONT: SUB $20
        LD L,A
        LD H,0
        LD D,H
        LD E,L
        ADD HL,HL
        ADD HL,HL
        ADD HL,HL
        AND A
        SBC HL,DE           ; times 7
        LD DE,FONT
        ADD HL,DE
        LD DE,GLYPH
        LD BC,7
        LDIR
        XOR A
        LD (DE),A           ; the eighth row is always empty
        RET

; GFBLOCK: block graphic A: bit 0 top right, bit 1 top left, bit 2 bottom
; right, bit 3 bottom left, each a quarter of the whole cell.
GFBLOCK:
        LD C,A
        XOR A
        BIT 1,C
        JR Z,GB1
        OR $E0
GB1:    BIT 0,C
        JR Z,GB2
        OR $1C
GB2:    LD HL,GLYPH
        LD B,4
GB3:    LD (HL),A
        INC HL
        DJNZ GB3
        XOR A
        BIT 3,C
        JR Z,GB4
        OR $E0
GB4:    BIT 2,C
        JR Z,GB5
        OR $1C
GB5:    LD B,4
GB6:    LD (HL),A
        INC HL
        DJNZ GB6
        RET

; GFUDG: user-defined graphic A from UDG, its 8 columns squeezed into 6:
; columns 1 and 2 become one, and so do 5 and 6.
GFUDG:  SUB $90
        LD L,A
        LD H,0
        ADD HL,HL
        ADD HL,HL
        ADD HL,HL
        LD DE,(UDG)
        ADD HL,DE
        LD DE,GLYPH
        LD B,8
GU1:    PUSH BC
        LD A,(HL)
        LD C,A
        AND $80             ; column 0
        LD B,A
        LD A,C
        AND $60             ; columns 1 and 2
        JR Z,GU2
        SET 6,B
GU2:    LD A,C
        AND $10             ; column 3
        RLCA
        OR B
        LD B,A
        LD A,C
        AND $08             ; column 4
        RLCA
        OR B
        LD B,A
        LD A,C
        AND $06             ; columns 5 and 6
        JR Z,GU3
        SET 3,B
GU3:    LD A,C
        AND $01             ; column 7
        RLCA
        RLCA
        OR B
        LD (DE),A
        INC HL
        INC DE
        POP BC
        DJNZ GU1
        RET

CTRLNAMES:
        DB "ipfbvo@t"

; ---------------------------------------------------------------------------
; Pixels
; ---------------------------------------------------------------------------
;
; Column c's 6 pixels start at pixel 6c: in byte 3(c/4) shifted right by 0
; for c%4 = 0, in the same byte shifted by 6 for 1 (spilling 4 pixels
; into the next byte), in the next byte shifted by 4 for 2 (spilling 2),
; and in the byte after shifted by 2 for 3.

CELLOFF:    DB 0,0,1,2      ; the byte, after 3(c/4)
CELLKEEPH:  DB $03,$FC,$F0,$C0  ; what the cell leaves of its first byte
CELLKEEPL:  DB $FF,$0F,$3F,$FF  ; and of the next

; CELLADDR: HL = the screen address of row B's top pixel line at column
; C's first byte; E = c%4.
CELLADDR:
        LD A,C
        AND 3
        LD E,A
        LD D,0
        LD HL,CELLOFF
        ADD HL,DE
        LD A,C
        SRL A
        SRL A
        LD D,A
        ADD A,A
        ADD A,D             ; 3(c/4)
        ADD A,(HL)
        LD D,A              ; the byte in the row
        LD A,B
        AND $18
        OR $40
        LD H,A
        LD A,B
        AND 7
        RRCA
        RRCA
        RRCA
        OR D
        LD L,A
        RET

; BLITROW: ROWBUF written to screen row B. Each cell gets the glyph
; table's slot for it: a character of the font has its own, and anything
; else (a block graphic, a UDG, a control code's letter or number, the
; cell marked inverse) a slot made for the row, shared by the cells with
; the same code. Then each pixel line is written from the table.
BLITROW:
        LD A,B
        LD (BLROW),A
        XOR A
        LD (DYNN),A
        LD HL,ROWBUF+COLS   ; the row up to its last cell that is not blank
        LD B,COLS
LC1:    DEC HL
        LD A,(HL)
        CP ' '
        JR NZ,LC2
        DJNZ LC1
LC2:    LD A,(ROWINV)       ; B: that many columns, or the inverse cell's
        INC A
        CP B
        JR C,LC3
        JR Z,LC3
        LD B,A
LC3:    LD A,B
        CP 41
        JR C,LC4
        LD A,10             ; columns 40 or 41: 10 groups of four and the two
        LD (BLGROUPS),A
        LD A,1
        LD (BLTAIL),A
        LD A,COLS
        JR LC5
LC4:    ADD A,3             ; else the groups of four that hold them
        SRL A
        SRL A
        LD (BLGROUPS),A
        ADD A,A
        ADD A,A
        LD B,A
        XOR A
        LD (BLTAIL),A
        LD A,B
LC5:    LD (BLPREP),A
        LD HL,ROWBUF
        LD BC,SLOTLO        ; C: the column, as SLOTLO starts a page
        AND A
        JR Z,RWPIX          ; a blank row
RW1:    LD A,(ROWINV)
        CP C
        JR Z,RWDYN
        LD A,(HL)
        CP $20
        JR C,RWDYN
        CP $80
        JR NC,RWDYN
        SUB $20             ; a character of the font
RW2:    LD (BC),A
        SET 7,C             ; SLOTHI: the same slot in the upper halves
        OR $80
        LD (BC),A
        RES 7,C
        INC HL
        INC C
        LD A,(BLPREP)
        CP C
        JR NZ,RW1
        JR RWPIX
RWDYN:  LD D,0
        LD A,(ROWINV)
        CP C
        JR NZ,RWD1
        INC D               ; the cell marked inverse
RWD1:   LD A,(HL)
        PUSH HL
        PUSH BC
        CALL MAKEDYN        ; A: its slot
        POP BC
        POP HL
        JR RW2
RWPIX:  LD A,(BLROW)
        LD C,A
        CALL ROWADDR        ; HL: the row's top pixel line
        LD D,HIGH GT
        LD B,HIGH SLOTLO
        LD A,8
        LD (BLCOUNT),A
BP1:    LD C,LOW SLOTLO
        LD A,(BLCOUNT)
        CP 5
        JR NC,BP2
        LD C,LOW SLOTHI     ; lines 4 to 7
BP2:    PUSH HL
        CALL BLITLINE
        POP HL
        INC H
        INC D
        LD A,D
        CP HIGH GT+4
        JR NZ,BP3
        LD D,HIGH GT
BP3:    LD A,(BLCOUNT)
        DEC A
        LD (BLCOUNT),A
        JR NZ,BP1
        RET

; BLITLINE: one pixel line of the row: HL its first screen byte, D the
; glyph table's page for the line, BC the slots (SLOTLO or SLOTHI). Every
; four cells make three whole bytes: the first cell is bits 7-2 of the
; first byte, the second bits 1-0 of it and 7-4 of the next, the third
; bits 3-0 of that and 7-6 of the last, the fourth bits 5-0 of the last.
; Glyphs are in bits 7-2, so each cell is its glyph rotated into place.
BLITLINE:
        LD A,(BLGROUPS)
        AND A
        JR Z,BLZ
        ADD A,A
        ADD A,A
        ADD A,C
        LD (BLEND),A        ; the groups of four, from column 0
BLG:    LD A,(BC)
        INC C
        LD E,A
        LD A,(DE)
        LD (HL),A           ; the first cell
        LD A,(BC)
        INC C
        LD E,A
        LD A,(DE)
        RLCA
        RLCA
        LD E,A
        AND $03
        OR (HL)
        LD (HL),A           ; the second
        INC L
        LD A,E
        AND $FC
        LD (HL),A
        LD A,(BC)
        INC C
        LD E,A
        LD A,(DE)
        RLCA
        RLCA
        RLCA
        RLCA
        LD E,A
        AND $0F
        OR (HL)
        LD (HL),A           ; the third
        INC L
        LD A,E
        AND $F0
        LD (HL),A
        LD A,(BC)
        INC C
        LD E,A
        LD A,(DE)
        RRCA
        RRCA
        AND $3F
        OR (HL)
        LD (HL),A           ; the fourth
        INC L
        LD A,(BLEND)
        CP C
        JR NZ,BLG
BLZ:    LD A,(BLTAIL)
        AND A
        JR NZ,BLT
        LD A,L              ; the blank rest of the pixel line, as zeros
        AND $1F
        LD E,A
        LD A,32
        SUB E
        RET Z
        LD E,A
        XOR A
BLZ1:   LD (HL),A
        INC L
        DEC E
        JR NZ,BLZ1
        RET
BLT:    LD A,(BC)           ; columns 40 and 41, and the row's last 4 pixels empty
        INC C
        LD E,A
        LD A,(DE)
        LD (HL),A
        LD A,(BC)
        LD E,A
        LD A,(DE)
        RLCA
        RLCA
        LD E,A
        AND $03
        OR (HL)
        LD (HL),A
        INC L
        LD A,E
        AND $F0
        LD (HL),A
        RET

; MAKEDYN: A = the glyph table slot for cell code A, made in one of the
; row's own slots; inverse if D is 1. A slot made for the same code
; earlier in the row is shared; an inverse cell has its own. Once all
; DYNMAX are used, the cell shows as ?.
MAKEDYN:
        LD E,A
        LD A,D
        AND A
        JR NZ,MD2
        LD HL,DYNCODE       ; made already in this row?
        LD A,(DYNN)
        AND A
        JR Z,MD2
        LD B,A
        LD C,0
MD1:    LD A,(HL)
        CP E
        JR Z,MD5
        INC HL
        INC C
        DJNZ MD1
MD2:    LD A,(DYNN)
        CP DYNMAX
        LD A,'?'-$20
        RET NC
        PUSH DE
        LD A,E
        CALL GLYPHFOR       ; GLYPH
        POP DE
        LD A,D
        AND A
        CALL NZ,GLYPHINV
        LD A,(DYNN)
        LD C,A
        LD B,0
        LD HL,DYNCODE
        ADD HL,BC
        LD A,D
        AND A
        LD A,E
        JR Z,MD3
        LD A,$FF            ; an inverse cell is not shared: no code is $FF
MD3:    LD (HL),A
        LD A,C              ; GLYPH's rows into the slot, a page a line
        ADD A,DYNSLOT
        LD E,A
        LD D,HIGH GT
        LD HL,GLYPH
        LD B,8
MD4:    LD A,(HL)
        LD (DE),A
        INC HL
        INC D
        LD A,D
        CP HIGH GT+4
        JR NZ,MD6
        LD D,HIGH GT        ; lines 4 to 7 in the upper halves
        SET 7,E
MD6:    DJNZ MD4
        LD HL,DYNN
        INC (HL)
MD5:    LD A,C
        ADD A,DYNSLOT
        RET

; XORCELL: the cell at row B, column C inverted on E pixel lines from line D.
XORCELL:
        PUSH DE
        CALL CELLADDR
        LD D,0
        PUSH HL
        LD HL,CELLKEEPH
        ADD HL,DE
        LD A,(HL)
        CPL
        LD B,A              ; B, C: the cell's bits in each byte
        LD HL,CELLKEEPL
        ADD HL,DE
        LD A,(HL)
        CPL
        LD C,A
        POP HL
        POP DE
        LD A,H
        ADD A,D
        LD H,A
XC1:    LD A,(HL)
        XOR B
        LD (HL),A
        INC L
        LD A,(HL)
        XOR C
        LD (HL),A
        DEC L
        INC H
        DEC E
        JR NZ,XC1
        RET

; ROWADDR: HL = the screen address of row C's top pixel line.
ROWADDR:
        LD A,C
        AND $18
        OR $40
        LD H,A
        LD A,C
        AND 7
        RRCA
        RRCA
        RRCA
        LD L,A
        RET

; CLEARROW: row C emptied.
CLEARROW:
        PUSH BC
        CALL ROWADDR
        LD B,8
CR1:    PUSH BC
        PUSH HL
        LD D,H
        LD E,L
        INC DE
        LD (HL),0
        LD BC,31
        LDIR
        POP HL
        POP BC
        INC H
        DJNZ CR1
        POP BC
        RET

; CLEARFROM: rows C to ROWS-1 emptied.
CLEARFROM:
        LD A,C
        CP ROWS
        RET NC
        CALL CLEARROW
        INC C
        JR CLEARFROM

; COPYROW: row B's pixels copied onto row C.
COPYROW:
        PUSH BC
        CALL ROWADDR
        EX DE,HL            ; DE: row C
        LD C,B
        CALL ROWADDR        ; HL: row B
        LD B,8
CPR1:   PUSH BC
        PUSH HL
        PUSH DE
        LD BC,32
        LDIR
        POP DE
        POP HL
        POP BC
        INC H
        INC D
        DJNZ CPR1
        POP BC
        RET

; PIXUP: listing rows 1 to ROWS-1 moved up a row, the last one emptied.
PIXUP:  LD B,1
PU1X:   LD C,B
        DEC C
        CALL COPYROW
        INC B
        LD A,B
        CP ROWS
        JR C,PU1X
        LD C,ROWS-1
        JP CLEARROW

; PIXDOWN: listing rows 0 to ROWS-2 moved down a row, the first emptied.
PIXDOWN:
        LD B,ROWS-2
PD1X:   LD C,B
        INC C
        CALL COPYROW
        DEC B
        BIT 7,B
        JR Z,PD1X
        LD C,0
        JP CLEARROW

; SCREENINIT: the screen emptied, the listing black on white and the
; status row white on black.
SCREENINIT:
        LD HL,$4000
        LD DE,$4001
        LD BC,$17FF
        LD (HL),0
        LDIR
        LD HL,$5800
        LD DE,$5801
        LD BC,ROWS*32-1
        LD (HL),ATTR_LIST
        LDIR
        LD HL,$5800+(ROWS*32)
        LD DE,$5800+(ROWS*32)+1
        LD BC,31
        LD (HL),ATTR_STATUS
        LDIR
        LD A,$FF
        LD (CXROW),A
        XOR A
        LD (CURSHOWN),A
        RET

; ---------------------------------------------------------------------------
; ENTER
; ---------------------------------------------------------------------------

; KENTER: the line goes into the program, or runs if it has no number.
; After a line goes in, the cursor is on a new line just after it.
KENTER: LD A,(READONLY)
        AND A
        JR NZ,KE1
        LD A,(MODIFIED)
        AND A
        JR NZ,KE3
        CALL CURPROG
        JR C,KE1            ; an unchanged line: a new line after it
        CALL ISBLANK        ; the new line: an untouched auto number does nothing
        RET Z
        LD A,(AUTOON)
        AND A
        JR Z,KE3
        CALL ONLYNUMBER
        RET Z
KE3:    CALL ISBLANK
        RET Z
        CALL CHECKLINE
        RET NZ              ; refused: the mistake is marked
        LD A,B
        OR C
        JP Z,RUNCMD         ; no number: a command
        CALL STORELINE
        RET NZ
        LD H,B
        LD L,C
KE2:    INC HL              ; the new line goes just after the line entered
        LD (SLOTBEF),HL
        DEC HL
        CALL AUTOAFTER
        LD HL,SLOT
        CALL SETCUR
        LD A,(CURCOL)
        LD (COLWANT),A
        JP NEEDALLON
KE1:    LD HL,(CURLINE)     ; a new line after this one
        JR KE2

; AUTOAFTER: with auto on, the number it gives next is the one after line
; HL; past 9999, auto stops.
AUTOAFTER:
        LD A,(AUTOON)
        AND A
        RET Z
        LD DE,(AUTOSTEP)
        ADD HL,DE
        LD (AUTONEXT),HL
        LD DE,10000
        AND A
        SBC HL,DE
        RET C
        XOR A
        LD (AUTOON),A
        RET

; ONLYNUMBER: Z if EDBUF is a number and spaces only.
ONLYNUMBER:
        LD HL,EDBUF
        LD BC,(EDLEN)
ON1:    LD A,B
        OR C
        RET Z
        LD A,(HL)
        INC HL
        DEC BC
        CP ' '
        JR Z,ON1
        CP '0'
        JR C,ON2
        CP '9'+1
        JR C,ON1
ON2:    OR 1
        RET

; ---------------------------------------------------------------------------
; Checking a line, as the ROM does
; ---------------------------------------------------------------------------

; CHECKLINE: EDBUF made into the editing area's bytes and checked by the
; ROM's LINE-SCAN, which adds the hidden form of every number. Z, with BC
; its line number (0 for a command), if it is right. NZ if the ROM refuses
; it: the cursor goes where the ROM found the mistake, which is marked,
; and its report is shown. Keywords are first looked for in either case;
; if the ROM refuses that, they are looked for in capitals only, which
; gives a variable such as "to" from a listing back as letters.
CHECKLINE:
        CALL CURPROG        ; a line from the program: capitals first
        LD A,0
        RLA
        LD (TOKUPPER),A
        CALL TRYLINE
        RET Z
        LD HL,(TRYOFF)      ; the first try's mistake, to show if both fail
        PUSH HL
        LD A,(ERR_NR)
        PUSH AF
        LD A,(TOKUPPER)
        XOR 1
        LD (TOKUPPER),A
        CALL TRYLINE
        JR NZ,CL1
        POP AF
        POP HL
        CP A
        RET
CL1:    POP AF
        LD (LASTERR),A
        POP HL              ; the byte the ROM stopped at
        LD (TOKTARGET),HL
        CALL SET_MIN        ; nothing left in the editing area
        LD (IY+0),$FF
        LD A,(TOKUPPER)
        XOR 1
        LD (TOKUPPER),A
        LD A,1              ; which place in EDBUF made that byte?
        LD (TOKMODE),A
        LD HL,(EDLEN)
        LD (TOKFOUND),HL
        CALL TOKENIZE
        XOR A
        LD (TOKMODE),A
        LD HL,(TOKFOUND)
        LD (CURIDX),HL
        LD (ERRIDX),HL
        CALL RASPB
        CALL REDRAWCUR
        LD A,(CURCOL)
        LD (COLWANT),A
        LD HL,1             ; the ROM's report on the status row
        JP MESSAGE

; TRYLINE: one try: Z, with BC the line number, if the ROM takes the line.
; The editing area then holds it, checked. NZ if not, with the editing
; area as the ROM left it at the mistake, X_PTR there.
TRYLINE:
        CALL SET_MIN
        XOR A
        CALL CHAN_OPEN      ; as MAIN-2 does before its editor
        XOR A
        LD (TOKMODE),A
        LD HL,TOKENIZE
        CALL TRAPCALL
        JR Z,TL1            ; out of memory
        LD HL,LINE_SCAN
        CALL TRAPCALL
        JR Z,TL2
        LD HL,E_LINE_NO
        CALL TRAPCALL
        JR Z,TL1
        CP A
        RET
TL2:    LD HL,(E_LINE)      ; as MAIN-2 does after a mistake
        CALL REMOVE_FP
        LD HL,(X_PTR)
        LD DE,(E_LINE)
        AND A
        SBC HL,DE
        LD (TRYOFF),HL
        LD (IY+38),0        ; X_PTR's high byte: no mistake for OUT-LINE to mark
        OR 1
        RET
TL1:    LD HL,$FFFF         ; out of memory: no place to mark
        LD (TRYOFF),HL
        OR 1
        RET

; TRAPCALL: calls the routine at HL with an error handler of its own, as the
; ROM's editor does around itself, so that a report from inside it (RST 8)
; comes back here rather than to the ROM's top level. NZ if it returned,
; Z if it reported, the report in ERR_NR. BC and HL come back as it left
; them.
TRAPCALL:
        LD (IY+0),$FF
        LD DE,(ERR_SP)
        PUSH DE
        LD DE,TRAPRET
        PUSH DE
        LD (ERR_SP),SP
        CALL JPHL
        POP DE              ; TRAPRET, not needed
TRAPRET:
        POP DE
        LD (ERR_SP),DE
        BIT 7,(IY+0)
        RET
JPHL:   JP (HL)

; STORELINE: the checked line put into the program, as MAIN-ADD does: a
; line with the same number goes first, and a number alone only takes
; it out. BC: the line number. NZ, with a message, if there is no room.
STORELINE:
        PUSH BC
        LD HL,ADDLINE
        CALL TRAPCALL
        POP BC
        PUSH AF
        PUSH BC
        CALL SET_MIN
        CALL TOPFIX         ; the line taken out may have been the top line
        POP BC
        POP AF
        JR Z,SL1
        CP A
        RET
SL1:    LD (IY+0),$FF
        LD HL,M_NOROOM
        JP MESSAGE

; ADDLINE: MAIN-ADD at $155D, without its return to MAIN-EXEC. BC: the
; line number, from E-LINE-NO, which left CH_ADD after the number.
ADDLINE:
        CALL E_LINE_NO
        LD (E_PPC),BC
        LD HL,(CH_ADD)
        EX DE,HL
        LD HL,(WORKSP)
        SCF
        SBC HL,DE           ; the line's length from CH_ADD, with its ENTER
        PUSH HL
        LD H,B
        LD L,C
        CALL LINE_ADDR
        JR NZ,AL1
        CALL $19B8          ; NEXT-ONE: the old line with this number
        CALL RECLAIM_2      ; taken out
AL1:    POP BC
        LD A,C
        DEC A
        OR B
        JR Z,AL2            ; a number alone
        PUSH BC
        INC BC
        INC BC
        INC BC
        INC BC
        DEC HL
        LD DE,(PROG)
        PUSH DE
        CALL MAKE_ROOM
        POP HL
        LD (PROG),HL
        POP BC
        PUSH BC
        INC DE
        LD HL,(WORKSP)
        DEC HL
        DEC HL
        LDDR
        LD HL,(E_PPC)
        EX DE,HL
        POP BC
        LD (HL),B
        DEC HL
        LD (HL),C
        DEC HL
        LD (HL),E
        DEC HL
        LD (HL),D
AL2:    LD BC,(E_PPC)
        RET

; RUNCMD: the checked command in the editing area run as the ROM runs a
; typed one, from MAIN-3. The editor comes back through the interrupt
; routine once the ROM's editor waits again. NEW is the editor's own,
; which keeps it. A CLEAR that would put RAMTOP into the editor is the
; ROM's own report M, since P_RAMT is held down.
RUNCMD: CALL CMDSTART       ; HL: the command's first byte
        LD A,(HL)
        CP T_NEW
        JR NZ,RC_1
        CALL CURSOFF
        LD HL,EDFLAGS
        SET 0,(HL)          ; nothing to look at after NEW
        JP SOFTNEW
RC_1:   CALL CURSOFF
        XOR A
        LD (STATE),A
        LD HL,(CURLINE)     ; a command typed on the new line is gone after
        CALL ISKEYSLOT
        JR NZ,RC_2
        LD HL,0
        LD (EDLEN),HL
        LD (CURIDX),HL
        XOR A
        LD (MODIFIED),A
RC_2:   SET 0,(IY+48)       ; FLAGS2: MAIN-3 clears the screen first
        LD HL,(ERR_SP)      ; to the top level, as MAIN-2 is
        INC HL
        INC HL
        LD SP,HL
        JP MAIN_3

; CMDSTART: HL = the first byte of the command in the editing area, past
; any spaces.
CMDSTART:
        LD HL,(E_LINE)
CMS1:   LD A,(HL)
        CP ' '
        RET NZ
        INC HL
        JR CMS1

; ---------------------------------------------------------------------------
; Making the bytes the ROM's keyboard would have made
; ---------------------------------------------------------------------------
;
; TOKENIZE turns EDBUF's text into what typing the line in the ROM's editor
; puts in the editing area, one byte at a time through TOKEMIT:
;  - spaces before the line number, and after it, go; its digits stay.
;  - a keyword, written in letters (in capitals only if TOKUPPER), becomes
;    its token. It must start where the character before is not a letter
;    or digit, and one ending in a letter must not be followed by one; a
;    space in the keyword matches any number of spaces, so GOTO and GO TO
;    both work. The longest keyword that fits is taken.
;  - one space before a keyword that LIST writes with a space before it
;    goes, and one space after a keyword that LIST writes with a space
;    after it; any others were typed, and stay.
;  - nothing in quotes or after REM is changed, and a colour control's
;    numbers are passed on as they are.

TOKENIZE:
        LD HL,(EDLEN)
        LD DE,EDBUF
        ADD HL,DE
        LD (TKEND),HL
        EX DE,HL            ; HL: EDBUF
        XOR A
        LD (TQUOTED),A
        LD (TREM),A
        LD (THELD),A
        LD (TSKIP1),A
        LD (TPREV),A
        LD D,A
        LD E,A
        LD (TOKCOUNT),DE
TK1:    CALL TKATEND        ; spaces before the number
        RET Z
        LD A,(HL)
        CP ' '
        JR NZ,TK2
        INC HL
        JR TK1
TK2:    CALL ISDIGIT
        JR NC,TKLOOP
TK3:    LD A,(HL)           ; the number's digits
        CALL ISDIGIT
        JR NC,TK4
        CALL TOKEMIT
        INC HL
        CALL TKATEND
        RET Z
        JR TK3
TK4:    CALL TKATEND        ; and the spaces after it
        RET Z
        LD A,(HL)
        CP ' '
        JR NZ,TKLOOP
        INC HL
        JR TK4

TKLOOP: CALL TKATEND
        JP Z,TKFLUSH
        LD A,(HL)
        CP $10
        JR C,TKPLAIN
        CP $18
        JR C,TKCTRL
        LD B,A
        LD A,(TREM)
        AND A
        LD A,B
        JR NZ,TKRAW
        LD A,(TQUOTED)
        AND A
        LD A,B
        JR NZ,TKQUOTED
        CP ' '
        JR Z,TKSPACE
        PUSH AF
        XOR A
        LD (TSKIP1),A
        POP AF
        CP '"'
        JR Z,TKQUOTE
        CP '<'
        JP Z,TKTRY
        CP '>'
        JP Z,TKTRY
        CALL ISLETTER
        JR NC,TKPLAIN
        LD A,(TPREV)
        AND A
        JR Z,TKTRY
        LD A,(HL)
TKPLAIN:
        CALL TKFLUSH
        LD A,(HL)
        CALL TOKEMIT
        LD A,(HL)
        CALL ISALNUM
        LD A,0
        RLA
        LD (TPREV),A
        INC HL
        JR TKLOOP
TKCTRL: CALL TKFLUSH        ; a colour control and its numbers, as they are
        LD A,(HL)
        LD B,1
        CP $16
        JR C,TKC1
        INC B
TKC1:   CALL TOKEMIT
        INC HL
        CALL TKATEND
        JR Z,TKLOOP
        LD A,(HL)
        DJNZ TKC1
        JR TKLOOP
TKRAW:  CALL TKFLUSH
        LD A,(HL)
        CALL TOKEMIT
        INC HL
        JR TKLOOP
TKQUOTED:
        CALL TOKEMIT
        LD A,(HL)
        INC HL
        CP '"'
        JP NZ,TKLOOP
        XOR A
        LD (TQUOTED),A
        LD (TPREV),A
        JP TKLOOP
TKSPACE:
        INC HL
        XOR A
        LD (TPREV),A
        LD A,(TSKIP1)
        AND A
        JR Z,TKS1
        XOR A               ; the space after a keyword: LIST's
        LD (TSKIP1),A
        JP TKLOOP
TKS1:   CALL TKFLUSH        ; a space before this one stays
        LD A,1
        LD (THELD),A        ; this one is held back
        JP TKLOOP
TKQUOTE:
        CALL TKFLUSH
        LD A,'"'
        CALL TOKEMIT
        INC HL
        LD A,1
        LD (TQUOTED),A
        JP TKLOOP
TKTRY:  CALL MATCHKW        ; carry: A the token, DE past it
        JR NC,TKPLAIN
        LD B,A
        LD A,(THELD)
        AND A
        JR Z,TKT1
        XOR A
        LD (THELD),A
        LD A,B
        CALL LEADING
        JR C,TKT1           ; LIST puts that space in itself
        LD A,' '
        CALL TOKEMIT
TKT1:   LD A,B
        CALL TOKEMIT
        EX DE,HL
        XOR A
        LD (TPREV),A
        LD A,B
        CALL TRAILING
        LD A,0
        RLA
        LD (TSKIP1),A
        LD A,B
        CP T_REM
        JP NZ,TKLOOP
        LD A,1              ; REM: the rest as it is, but for LIST's space
        LD (TREM),A
        XOR A
        LD (TSKIP1),A
        CALL TKATEND
        JP Z,TKLOOP
        LD A,(HL)
        CP ' '
        JP NZ,TKLOOP
        INC HL
        JP TKLOOP

; TKFLUSH: a space held back goes out after all.
TKFLUSH:
        LD A,(THELD)
        AND A
        RET Z
        XOR A
        LD (THELD),A
        LD A,' '
        JP TOKEMIT

; TKATEND: Z if HL is at the end of EDBUF.
TKATEND:
        PUSH HL
        PUSH DE
        LD DE,(TKEND)
        AND A
        SBC HL,DE
        POP DE
        POP HL
        RET

; TOKEMIT: byte A made: into the editing area through ADD-CHAR, as a key
; would put it there (TOKMODE 0), or only counted (1), noting the place in
; EDBUF (HL) the byte numbered TOKTARGET came from.
TOKEMIT:
        PUSH HL
        PUSH DE
        PUSH BC
        LD B,A
        LD A,(TOKMODE)
        AND A
        JR NZ,TE1
        LD A,B
        CALL ADD_CHAR
        JR TE2
TE1:    PUSH HL
        LD HL,(TOKCOUNT)
        LD DE,(TOKTARGET)
        AND A
        SBC HL,DE
        POP HL
        JR NZ,TE2
        LD DE,EDBUF
        AND A
        SBC HL,DE
        LD (TOKFOUND),HL
TE2:    LD HL,(TOKCOUNT)
        INC HL
        LD (TOKCOUNT),HL
        POP BC
        POP DE
        POP HL
        RET

; MATCHKW: the longest keyword written at HL in EDBUF: carry, A its token
; and DE the place after it; no carry if none. HL is left as it was.
MATCHKW:
        LD (MKSTART),HL
        LD HL,0
        LD (BESTLEN),HL
        LD DE,TKN_TABLE
        LD A,$A5
MK1:    LD (MKTOK),A
        LD HL,(MKSTART)
        CALL MATCHONE       ; carry if it matches, MATCHEND past it
        JR NC,MK2
        LD HL,(MATCHEND)
        LD BC,(MKSTART)
        AND A
        SBC HL,BC           ; its length
        LD BC,(BESTLEN)
        PUSH HL
        AND A
        SBC HL,BC
        POP HL
        JR C,MK2
        JR Z,MK2
        LD (BESTLEN),HL     ; the longest yet
        LD A,(MKTOK)
        LD (BESTTOK),A
        LD HL,(MATCHEND)
        LD (BESTEND),HL
MK2:    LD A,(DE)           ; on to the next keyword
        INC DE
        RLA
        JR NC,MK2
        LD A,(MKTOK)
        INC A
        JR NZ,MK1           ; up to COPY, $FF
        LD HL,(MKSTART)
        LD BC,(BESTLEN)
        LD A,B
        OR C
        RET Z               ; no carry: none
        LD DE,(BESTEND)
        LD A,(BESTTOK)
        SCF
        RET

; MATCHONE: carry if the keyword at DE in the table is written at HL;
; MATCHEND then the place after it. DE is left as it was.
MATCHONE:
        PUSH DE
MO1:    LD A,(DE)
        AND $7F
        CP ' '
        JR NZ,MO3
MO2:    CALL TKATEND        ; a space in the keyword: any number of spaces
        JR Z,MO5
        LD A,(HL)
        CP ' '
        JR NZ,MO5
        INC HL
        JR MO2
MO3:    LD C,A
        CALL TKATEND
        JR Z,MONO
        LD A,(HL)
        LD B,A
        LD A,(TOKUPPER)
        AND A
        LD A,B
        JR NZ,MO4
        CP 'a'
        JR C,MO4
        CP 'z'+1
        JR NC,MO4
        SUB $20             ; a small letter matches its capital
MO4:    CP C
        JR NZ,MONO
        INC HL
MO5:    LD A,(DE)
        INC DE
        BIT 7,A
        JR Z,MO1
        AND $7F             ; the last character: a letter must end the word
        CALL ISLETTER
        JR NC,MOYES
        CALL TKATEND
        JR Z,MOYES
        LD A,(HL)
        CALL ISALNUM
        JR C,MONO
MOYES:  LD (MATCHEND),HL
        POP DE
        SCF
        RET
MONO:   POP DE
        AND A
        RET

; LEADING: carry if LIST writes token A with a space before it, unless
; one is there: PO-SEARCH does for a token from OR on ($C5) whose first
; character is a letter.
LEADING:
        CP $C5
        CCF
        RET NC
        PUSH HL
        CALL TOKENTRY
        LD A,(HL)
        POP HL
        AND $7F
        CP 'A'
        CCF
        RET

; TRAILING: carry if LIST writes token A with a space after it: not for
; RND, INKEY$ and PI, and not for one ending in a character below A other
; than $.
TRAILING:
        CP $A8
        CCF
        RET NC
        PUSH HL
        CALL TOKENTRY
TR1:    BIT 7,(HL)
        INC HL
        JR Z,TR1
        DEC HL
        LD A,(HL)
        POP HL
        AND $7F
        CP '$'
        SCF
        RET Z
        CP 'A'
        CCF
        RET

; TOKENTRY: HL = token A's text in the ROM's table: from TOKIDX, the
; eighth keyword at or before it, then stepping over the rest.
TOKENTRY:
        PUSH BC
        PUSH DE
        SUB $A5
        LD B,A
        AND 7
        LD C,A              ; keywords to step over
        LD A,B
        RRCA
        RRCA
        AND $3E             ; (A/8)*2
        LD E,A
        LD D,0
        LD HL,TOKIDX
        ADD HL,DE
        LD E,(HL)
        INC HL
        LD D,(HL)
        EX DE,HL
        LD A,C
        AND A
        JR Z,TE4
        LD B,C
TE3:    BIT 7,(HL)
        INC HL
        JR Z,TE3
        DJNZ TE3
TE4:    POP DE
        POP BC
        RET

; ISDIGIT, ISLETTER, ISALNUM: carry if A is one.
ISDIGIT:
        CP '0'
        CCF
        RET NC
        CP '9'+1
        RET
ISLETTER:
        CP 'A'
        CCF
        RET NC
        CP 'Z'+1
        RET C
        CP 'a'
        CCF
        RET NC
        CP 'z'+1
        RET
ISALNUM:
        CALL ISDIGIT
        RET C
        JR ISLETTER

; ---------------------------------------------------------------------------
; Prompts
; ---------------------------------------------------------------------------

; PROMPT: asks on the status row, with the text at HL, for what is typed
; into PBUF, which starts as the 0-ended text at DE (or empty if DE is 0).
; Z with PBUF filled in when ENTER is pressed, NZ when BREAK or EXTEND.
PROMPT: LD (PROMPTPTR),HL
        LD HL,PBUF
        LD (HL),0
        LD A,D
        OR E
        JR Z,PM2
        EX DE,HL
        LD DE,PBUF
        LD B,PBUFMAX
PM1:    LD A,(HL)
        LD (DE),A
        AND A
        JR Z,PM2
        INC HL
        INC DE
        DJNZ PM1
        XOR A
        LD (DE),A
PM2:    CALL PMDRAW
        CALL GETKEY
        CP K_ENTER
        RET Z
        CP K_BREAK
        JR Z,PMNO
        CP K_EXTEND
        JR Z,PMNO
        CP K_DELETE
        JR Z,PMDEL
        CP $20
        JR C,PM2
        CP $80
        JR NC,PM2
        LD C,A              ; a character on the end, if the row and PBUF have room
        LD A,(DRAWCOL)      ; where PMDRAW left the cursor
        CP COLS-1
        JR NC,PM2
        CALL PBLEN
        CP PBUFMAX
        JR NC,PM2
        LD (HL),C
        INC HL
        LD (HL),0
        JR PM2
PMDEL:  CALL PBLEN
        AND A
        JR Z,PM2
        DEC HL
        LD (HL),0
        JR PM2
PMNO:   LD HL,0
        LD (MSGPTR),HL
        OR 1
        RET

; PBLEN: A = PBUF's length, HL its end.
PBLEN:  LD HL,PBUF
        LD B,0
PL1:    LD A,(HL)
        AND A
        LD A,B
        RET Z
        INC HL
        INC B
        JR PL1

; PMDRAW: the prompt and what has been typed, the cursor after it.
PMDRAW: CALL BEGINOUT
        LD A,ROWS
        LD (DRAWROW),A
        LD (CLIPLO),A
        LD (CLIPHI),A
        XOR A
        LD (DRAWCOL),A
        LD (DRAWMODE),A
        LD (PARAMS),A
        CALL BEGINROW
        LD HL,(PROMPTPTR)
        CALL PRINTSTR
        LD HL,PBUF
PD1P:   LD A,(HL)
        AND A
        JR Z,PD2P
        PUSH HL
        RST $10
        POP HL
        INC HL
        JR PD1P
PD2P:   CALL FLUSHROW
        CALL ENDOUT
        LD A,ROWS
        LD (CXROW),A
        LD A,(DRAWCOL)
        LD (CXCOL),A
        RET

; PROMPTNUMS: PROMPT, then PARSENUMS. If the prompt is given up or there
; is no number, the command that called it is done: PROMPTDONE, in its
; place.
PROMPTNUMS:
        CALL PROMPT
        JR NZ,PNS1
        CALL PARSENUMS
        RET NC
PNS1:   POP HL
        ; fall into PROMPTDONE

; PROMPTDONE: the cursor back on the listing after a prompt.
PROMPTDONE:
        JP ENSUREVIS

; NUMTEXT: DIGITS = the number HL written out, 0 at its end. NUMTEXTAT:
; the same at DE.
NUMTEXT:
        LD DE,DIGITS
NUMTEXTAT:
        PUSH DE
        LD DE,POWERS
        LD (NTPOW),DE
        POP DE
        XOR A
        LD (NTSTARTED),A
NT1:    PUSH DE
        LD DE,(NTPOW)
        LD A,(DE)
        LD C,A
        INC DE
        LD A,(DE)
        LD B,A              ; BC: the power of ten
        INC DE
        LD (NTPOW),DE
        POP DE
        LD A,B
        OR C
        JR Z,NT4
        LD A,'0'-1
NT2:    INC A
        AND A
        SBC HL,BC
        JR NC,NT2
        ADD HL,BC
        CP '0'
        JR NZ,NT3
        PUSH AF             ; a 0 before the first digit is left out, but for 1s
        LD A,(NTSTARTED)
        AND A
        JR NZ,NT2B
        LD A,C
        DEC A
        OR B
        JR Z,NT2B
        POP AF
        JR NT1
NT2B:   POP AF
NT3:    LD (DE),A
        INC DE
        LD A,1
        LD (NTSTARTED),A
        JR NT1
NT4:    XOR A
        LD (DE),A
        RET

POWERS: DW 10000,1000,100,10,1,0

; PARSENUMS: NUMA and NUMB from PBUF, written as a number, or two with a
; comma between; carry if there is no first number. NUMB is left as it
; was if there is no second. A first number of 0 is 1, since no line is
; numbered 0.
PARSENUMS:
        LD HL,PBUF
        CALL READNUM
        RET C
        LD A,D
        OR E
        JR NZ,PN0
        INC DE
PN0:    LD (NUMA),DE
        CALL SKIPSP
        LD A,(HL)
        CP ','
        JR NZ,PN1
        INC HL
        CALL READNUM
        JR C,PN1
        LD (NUMB),DE
PN1:    AND A
        RET

; READNUM: DE = the number at HL, which moves past it; carry if none. A
; number above NUMMAX is NUMMAX, so that no line is looked for past the
; program, where LINE-ADDR would go on into the variables.
READNUM:
        CALL SKIPSP
        LD A,(HL)
        CALL ISDIGIT
        CCF
        RET C
        LD DE,0
RN1:    LD A,(HL)
        CALL ISDIGIT
        JR NC,RN2
        INC HL
        PUSH HL
        LD HL,NUMMAX/10
        AND A
        SBC HL,DE
        JR C,RN3            ; another digit takes it past NUMMAX
        LD H,D
        LD L,E
        ADD HL,HL
        ADD HL,HL
        ADD HL,DE
        ADD HL,HL           ; times 10, at most 16380
        SUB '0'
        LD E,A
        LD D,0
        ADD HL,DE
        EX DE,HL
        LD HL,NUMMAX
        AND A
        SBC HL,DE
        JR NC,RN4
RN3:    LD DE,NUMMAX
RN4:    POP HL
        JR RN1
RN2:    AND A
        RET

; SKIPSP: HL past any spaces.
SKIPSP: LD A,(HL)
        CP ' '
        RET NZ
        INC HL
        JR SKIPSP

; ---------------------------------------------------------------------------
; EXTEND commands
; ---------------------------------------------------------------------------

; KAUTO: EXTEND A. Auto line numbers on, from a start and with a step
; asked for, or off again.
KAUTO:  LD A,(AUTOON)
        AND A
        JR Z,KA1
        XOR A
        LD (AUTOON),A
        CALL CLEARAUTO
        LD HL,M_AUTOOFF
        JP MESSAGE
KA1:    CALL CURPROG        ; offered: the line after this one, or after the last
        JR C,KA2
        LD HL,SLOTEND
        CALL LASTLT
        JR NC,KA2
        LD HL,0
KA2:    LD DE,(AUTOSTEP)
        ADD HL,DE
        LD (NUMA),HL
        LD (NUMB),DE
        CALL OFFERTWO
        LD HL,P_AUTO
        CALL PROMPTNUMS
        LD HL,(NUMB)
        LD A,H
        OR L
        JR NZ,KA3
        LD HL,10
KA3:    LD (AUTOSTEP),HL
        LD HL,(NUMA)
        LD (AUTONEXT),HL
        LD A,1
        LD (AUTOON),A
        LD HL,(CURLINE)     ; the new line, if the cursor is on it, gets its number
        CALL ISKEYSLOT
        JP NZ,PROMPTDONE
        LD A,(MODIFIED)
        AND A
        JP NZ,PROMPTDONE
        CALL SETCUR
        CALL REDRAWCUR
        JP PROMPTDONE

; CLEARAUTO: an untouched auto number taken off the new line.
CLEARAUTO:
        LD HL,(CURLINE)
        CALL ISKEYSLOT
        RET NZ
        LD A,(MODIFIED)
        AND A
        RET NZ
        LD HL,0
        LD (EDLEN),HL
        LD (CURIDX),HL
        CALL REDRAWCUR
        RET

; OFFERTWO: the text a prompt starts with, NUMA,NUMB, in OFFER; DE points to it.
OFFERTWO:
        LD HL,(NUMA)
        CALL NUMTEXT
        LD HL,DIGITS
        LD DE,OFFER
        CALL COPYZ
        LD A,','
        LD (DE),A
        INC DE
        PUSH DE
        LD HL,(NUMB)
        CALL NUMTEXT
        POP DE
        LD HL,DIGITS
        CALL COPYZ
        XOR A
        LD (DE),A
        LD DE,OFFER
        RET

; COPYZ: the 0-ended text at HL copied to DE, which ends past it (not
; past its 0).
COPYZ:  LD A,(HL)
        AND A
        RET Z
        LD (DE),A
        INC HL
        INC DE
        JR COPYZ

; KGOTO: EXTEND G. The cursor to a line asked for, or the first after it.
KGOTO:  LD HL,P_GOTO
        LD DE,0
        CALL PROMPTNUMS
        CALL LEAVE
        JP NZ,PROMPTDONE
        LD HL,(NUMA)
        CALL FIRSTGE
        JR NC,KG1
        LD HL,SLOTEND
        LD (SLOTBEF),HL
        LD HL,SLOT
KG1:    JP JUMPTO

; JUMPTO: the cursor to the start of line HL, the listing drawn again.
JUMPTO: CALL SETCUR
        XOR A
        LD (COLWANT),A
        CALL NEEDALLON
        LD A,$FF
        LD (CXROW),A
        RET

; KFIND: EXTEND F. The text asked for looked for in the lines after the
; cursor's, round to the start and back.
KFIND:  LD HL,P_FIND
        LD DE,FINDSTR
        CALL PROMPT
        JP NZ,PROMPTDONE
        LD HL,PBUF
        LD DE,FINDSTR
        CALL COPYZ
        XOR A
        LD (DE),A
        ; fall into KFINDNEXT

; KFINDNEXT: EXTEND N. The same text again, after the cursor's line.
KFINDNEXT:
        LD A,(FINDSTR)
        AND A
        JP Z,PROMPTDONE     ; nothing to look for
        CALL LEAVE
        JP NZ,PROMPTDONE
        CALL CURPROG        ; from the line after the cursor's
        JR NC,KF1
        INC HL
        JR KF2
KF1:    LD HL,(SLOTBEF)
KF2:    LD (WALKKEY),HL
        LD A,2              ; at most twice round: from there, then from the top
        LD (ROWSCOUNT),A
KF3:    LD HL,(WALKKEY)
        CALL FIRSTGE
        JR NC,KF4
        LD HL,ROWSCOUNT     ; past the end: from the start
        DEC (HL)
        JR Z,KFNO
        LD HL,0
        LD (WALKKEY),HL
        JR KF3
KF4:    LD (WALKKEY),HL
        CALL KEYADDR
        LD DE,EDBUF         ; the line's text, as the cursor would edit it;
        LD BC,EDMAX         ; EDBUF is free, the cursor's line having been left
        CALL CAPTURE
        CALL SEARCH         ; carry: found at FINDHIT
        JR C,KF5
        LD HL,(WALKKEY)
        INC HL
        LD (WALKKEY),HL
        JR KF3
KF5:    LD HL,(WALKKEY)
        CALL JUMPTO
        LD HL,(FINDHIT)
        LD (CURIDX),HL
        CALL MEASURECUR
        LD A,(CURCOL)
        LD (COLWANT),A
        RET
KFNO:   LD HL,(CURLINE)     ; the cursor's line back in EDBUF
        CALL SETCUR
        LD HL,M_NOTFOUND
        CALL MESSAGE
        JP PROMPTDONE

; SEARCH: carry if FINDSTR is in EDBUF's first HL bytes, small letters
; and capitals alike; FINDHIT its place.
SEARCH: LD (WALKN),HL
        LD HL,0
SE1:    PUSH HL
        LD DE,(WALKN)
        AND A
        SBC HL,DE
        POP HL
        RET NC              ; not there (no carry)
        PUSH HL
        LD DE,EDBUF
        ADD HL,DE           ; HL: in EDBUF
        LD DE,FINDSTR
        LD BC,(WALKN)       ; BC: the text's end
        PUSH HL
        LD HL,EDBUF
        ADD HL,BC
        LD B,H
        LD C,L
        POP HL
SE2:    LD A,(DE)
        AND A
        JR Z,SE4            ; all of it matched
        PUSH HL
        AND A
        SBC HL,BC
        POP HL
        JR NC,SE3           ; ran off the end
        LD A,(DE)
        CALL UPPER
        PUSH BC
        LD B,A
        LD A,(HL)
        CALL UPPER
        CP B
        POP BC
        JR NZ,SE3
        INC HL
        INC DE
        JR SE2
SE3:    POP HL
        INC HL
        JR SE1
SE4:    POP HL
        LD (FINDHIT),HL
        SCF
        RET

; UPPER: A in capitals, if it is a small letter.
UPPER:  CP 'a'
        RET C
        CP 'z'+1
        RET NC
        SUB $20
        RET

; KDELLINE: EXTEND X. The line under the cursor taken out of the program.
KDELLINE:
        CALL CURPROG
        RET NC
        LD (NUMA),HL
        LD (NUMB),HL
        JR DELRANGE

; KDELRANGE: EXTEND D. The lines from one number to another taken out,
; once Y says so.
KDELRANGE:
        CALL LEAVE
        RET NZ
        CALL CURPROG
        JR C,KDR1
        LD HL,0
KDR1:   LD (NUMA),HL
        LD (NUMB),HL
        CALL OFFERTWO
        LD HL,P_DELETE
        CALL PROMPTNUMS
        CALL COUNTRANGE     ; HL: how many lines
        LD A,H
        OR L
        JR NZ,KDR2
        LD HL,M_NOLINES
        CALL MESSAGE
        JP PROMPTDONE
KDR2:   CALL NUMTEXT
        LD HL,P_SURE
        LD (MSGPTR),HL
        CALL STATUS
        CALL GETKEY
        LD HL,0
        LD (MSGPTR),HL
        OR $20
        CP 'y'
        JP NZ,PROMPTDONE
        ; fall into DELRANGE

; DELRANGE: lines NUMA to NUMB taken out of the program.
DELRANGE:
        LD HL,(NUMB)
        INC HL
        CALL LINE_ADDR
        PUSH HL
        LD HL,(NUMA)
        CALL LINE_ADDR
        EX DE,HL            ; DE: the first line to go
        POP HL              ; HL: the first line kept
        CALL RECLAIM_1
        CALL CURPROG        ; the cursor on the line after them
        JR NC,DR1
        LD DE,(NUMA)
        AND A
        SBC HL,DE
        JR C,DR1
        LD HL,(NUMB)
        LD DE,(CURLINE)
        AND A
        SBC HL,DE
        JR C,DR1
        LD HL,(NUMB)
        INC HL
        CALL FIRSTGE
        JR NC,DR2
        LD HL,SLOT
DR2:    CALL SETCUR
DR1:    CALL VIEWFIX
        CALL NEEDALLON
        LD HL,M_DELETED
        CALL MESSAGE
        JP PROMPTDONE

; COUNTRANGE: HL = how many lines are numbered NUMA to NUMB.
COUNTRANGE:
        LD HL,(NUMA)
        CALL LINE_ADDR
        LD BC,0
CRG1:   LD A,(HL)
        CP $40
        JR NC,CRG2
        PUSH HL
        LD D,(HL)
        INC HL
        LD E,(HL)
        LD HL,(NUMB)
        AND A
        SBC HL,DE
        POP HL
        JR C,CRG2
        INC BC
        PUSH BC
        CALL $19B8          ; NEXT-ONE
        EX DE,HL
        POP BC
        JR CRG1
CRG2:   LD H,B
        LD L,C
        RET

; ---------------------------------------------------------------------------
; Renumbering
; ---------------------------------------------------------------------------
;
; KRENUM: EXTEND R. Every line numbered again from a start, in steps. A
; GO TO, GO SUB, RUN, RESTORE, LIST, LLIST or SAVE ... LINE to a line given
; as a plain number is changed to go to the line's new number, both the
; digits and their hidden form, the line made longer or shorter as the
; digits need. A number past the last line goes to the last new number,
; unless it is past that too. A GO TO or GO SUB to anything else, such as
; GO TO n*10, cannot be followed, and is counted.

KRENUM: LD HL,10
        LD (NUMA),HL
        LD (NUMB),HL
        CALL OFFERTWO
        LD HL,P_RENUM
        CALL PROMPTNUMS
        CALL LEAVE
        JP NZ,PROMPTDONE
        LD HL,(NUMA)
        LD (RENSTART),HL
        LD HL,(NUMB)
        LD A,H
        OR L
        JR NZ,RN0
        INC HL
RN0:    LD (RENSTEP),HL
        LD HL,0             ; the last new number must be 9999 or less
        LD (NUMB),HL
        CALL COUNTALL       ; BC: the lines
        LD A,B
        OR C
        JP Z,RNDONE
        DEC BC
        LD HL,(RENSTART)
RN1A:   LD A,B
        OR C
        JR Z,RN2A
        LD DE,(RENSTEP)
        ADD HL,DE
        JP C,RNBIG
        DEC BC
        JR RN1A
RN2A:   LD DE,10000
        PUSH HL
        AND A
        SBC HL,DE
        POP HL
        JP NC,RNBIG
        LD (LASTNUM),HL
        ; the editor's own line numbers, mapped while the old ones are there
        LD HL,(CURLINE)
        CALL MAPKEY
        LD (CURLINE),HL
        LD HL,(TOPLINE)
        CALL MAPKEY
        LD (TOPLINE),HL
        LD HL,(SLOTBEF)
        CALL ISPROG
        JR NC,RN3A
        CALL FIRSTGE
        JR C,RN3B
        CALL MAPNUM
        JR RN3C
RN3B:   LD HL,SLOTEND
RN3C:   LD (SLOTBEF),HL
RN3A:   LD HL,(E_PPC)
        CALL MAPKEY
        LD (E_PPC),HL
        ; how much longer the program gets on the way, then whether there
        ; is room: lines are made longer and shorter in the program's order,
        ; so it may need more room part way than at the end
        LD A,1
        LD (RENDRY),A
        LD HL,0
        LD (RENGROW),HL
        LD (RENPEAK),HL
        LD (RENCOUNT),HL
        CALL RETARGET
        LD HL,(RENPEAK)
        LD A,H
        OR L
        JR Z,RN4A
        LD B,H
        LD C,L
        LD HL,TEST_ROOM
        CALL TRAPCALL
        JR NZ,RN4A
        LD (IY+0),$FF
        LD HL,M_NOROOM
        JP MESSAGE
RN4A:   XOR A
        LD (RENDRY),A
        LD HL,0
        LD (RENCOUNT),HL
        CALL RETARGET       ; the line numbers in the lines
        CALL RELINE         ; then the lines' own numbers
        LD HL,(CURLINE)
        CALL SETCUR
        CALL NEEDALLON
        LD HL,(RENCOUNT)
        LD A,H
        OR L
        LD HL,M_RENUMBERED
        JR Z,RN5A
        LD HL,(RENCOUNT)
        CALL NUMTEXT
        LD HL,M_NOTFOLLOWED
RN5A:   CALL MESSAGE
        JP PROMPTDONE
RNBIG:  LD HL,M_TOOBIG
        CALL MESSAGE
        JP PROMPTDONE
RNDONE: JP PROMPTDONE

; COUNTALL: BC = how many lines the program has.
COUNTALL:
        LD HL,(PROG)
        LD BC,0
CA1:    LD A,(HL)
        CP $40
        RET NC
        INC BC
        PUSH BC
        CALL $19B8          ; NEXT-ONE
        EX DE,HL
        POP BC
        JR CA1

; MAPKEY: a line key mapped to its new number; SLOT and ENDKEY as they are.
MAPKEY: CALL ISPROG
        RET NC
        ; fall into MAPNUM

; MAPNUM: HL = the new number of the first line numbered HL or more; past
; the last line, HL itself if it is past the last new number too, or else
; the last new number.
MAPNUM: PUSH DE
        PUSH BC
        LD (WALKN),HL
        LD HL,(PROG)
        LD DE,(RENSTART)
        LD (WALKKEY),DE
MP1:    LD A,(HL)
        CP $40
        JR NC,MP3           ; past the last line
        PUSH HL
        LD D,(HL)
        INC HL
        LD E,(HL)
        LD HL,(WALKN)
        EX DE,HL
        AND A
        SBC HL,DE           ; this line - the number: no carry if it is the one
        POP HL
        JR NC,MP2
        CALL $19B8          ; NEXT-ONE
        EX DE,HL
        PUSH HL
        LD HL,(WALKKEY)
        LD DE,(RENSTEP)
        ADD HL,DE
        LD (WALKKEY),HL
        POP HL
        JR MP1
MP2:    LD HL,(WALKKEY)
        JR MP4
MP3:    LD HL,(LASTNUM)     ; past the last line: past the last new one too
        LD DE,(WALKN)
        AND A
        SBC HL,DE
        LD HL,(WALKN)
        JR C,MP4            ; it is already
        LD HL,(LASTNUM)
        INC HL
        LD DE,10000
        PUSH HL
        AND A
        SBC HL,DE
        POP HL
        JR C,MP4
        LD HL,9999
MP4:    POP BC
        POP DE
        RET

; RETARGET: every line's GO TO and the rest looked at; RENDRY says whether
; only to add up RENGROW, or to change them.
RETARGET:
        LD HL,(PROG)
RT1:    LD A,(HL)
        CP $40
        RET NC
        LD (LINEADDR),HL
        INC HL
        INC HL
        INC HL
        INC HL              ; the line's first byte
        XOR A
        LD (TQUOTED),A
RT2:    LD A,(HL)
        CP $0D
        JR Z,RT9
        LD B,A
        LD A,(TQUOTED)
        AND A
        LD A,B
        JR Z,RT3
        CP '"'
        JR NZ,RT8
        XOR A
        LD (TQUOTED),A
        JR RT8
RT3:    CP '"'
        JR NZ,RT4
        LD A,1
        LD (TQUOTED),A
        JR RT8
RT4:    CP T_REM
        JR Z,RT9
        CP $0E
        JR NZ,RT5
        LD DE,6             ; a hidden number
        ADD HL,DE
        JR RT2
RT5:    CP $10
        JR C,RT8
        CP $16
        JR C,RT6
        CP $18
        JR NC,RT7
        INC HL              ; AT, TAB: two numbers
RT6:    INC HL              ; INK and the rest: one
        JR RT8
RT7:    CALL ISTARGETTOK
        JR NZ,RT8
        INC HL
        CALL TARGET         ; HL: past what it looked at
        JR RT2
RT8:    INC HL
        JR RT2
RT9:    LD HL,(LINEADDR)    ; the next line
        INC HL
        INC HL
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        ADD HL,DE
        JR RT1

; ISTARGETTOK: Z if A is a keyword followed by a line number.
ISTARGETTOK:
        LD (TGTOK),A
        CP T_GOTO
        RET Z
        CP T_GOSUB
        RET Z
        CP T_RUN
        RET Z
        CP T_RESTORE
        RET Z
        CP T_LIST
        RET Z
        CP T_LLIST
        RET Z
        CP T_LINE
        RET

; TARGET: HL after one of those keywords: a plain number there changed.
TARGET: CALL SKIPSP
        LD (TGSTART),HL     ; where its digits start
        LD B,0
TG1:    LD A,(HL)
        CALL ISDIGIT
        JR NC,TG2
        INC HL
        INC B
        JR TG1
TG2:    LD A,B
        AND A
        JP Z,TGNOT          ; no digits: an expression, or nothing
        LD (TGDIGITS),A
        LD A,(HL)
        CP $0E
        JP NZ,TGNOT
        INC HL
        LD A,(HL)           ; a small whole number: 0, sign 0, low, high, 0
        INC HL
        OR (HL)
        INC HL
        LD E,(HL)
        INC HL
        LD D,(HL)
        INC HL
        OR (HL)
        INC HL
        JP NZ,TGNOT
        PUSH HL
        CALL SKIPSP
        LD A,(HL)
        POP HL
        CP ':'
        JR Z,TG3
        CP $0D
        JR Z,TG3
        JP NZ,TGNOT
TG3:    PUSH HL             ; it is a plain number: DE
        EX DE,HL
        CALL MAPNUM
        LD (TGNEW),HL
        CALL NUMTEXT        ; DIGITS
        LD HL,DIGITS        ; how many digits now
        LD B,0
TG4:    LD A,(HL)
        AND A
        JR Z,TG5
        INC HL
        INC B
        JR TG4
TG5:    POP HL
        LD A,(TGDIGITS)
        LD C,A
        LD A,B
        SUB C               ; how many more
        LD (TGDIFF),A
        LD A,(RENDRY)
        AND A
        JR Z,TG6
        LD A,(TGDIFF)       ; only adding up
        LD E,A
        RLA
        SBC A,A
        LD D,A
        PUSH HL
        LD HL,(RENGROW)
        ADD HL,DE
        LD (RENGROW),HL
        EX DE,HL
        LD HL,(RENPEAK)     ; the most it has come to
        AND A
        SBC HL,DE
        JP P,TGPEAK
        LD (RENPEAK),DE
TGPEAK: POP HL
        RET
TG6:    LD A,(TGDIFF)
        AND A
        JR Z,TG8
        BIT 7,A
        JR NZ,TG7
        LD C,A              ; more digits: room made at the start of them
        LD B,0
        LD HL,(TGSTART)
        CALL MAKE_ROOM
        JR TG8
TG7:    NEG                 ; fewer: some taken back
        LD C,A
        LD B,0
        LD HL,(TGSTART)
        CALL RECLAIM_2
TG8:    LD A,(TGDIFF)       ; the line's length
        LD E,A
        RLA
        SBC A,A
        LD D,A
        LD HL,(LINEADDR)
        INC HL
        INC HL
        PUSH DE
        LD E,(HL)
        INC HL
        LD D,(HL)
        EX (SP),HL
        ADD HL,DE
        EX DE,HL
        POP HL
        LD (HL),D
        DEC HL
        LD (HL),E
        LD HL,(TGSTART)     ; the digits
        LD DE,DIGITS
TG9:    LD A,(DE)
        AND A
        JR Z,TG10
        LD (HL),A
        INC HL
        INC DE
        JR TG9
TG10:   INC HL              ; past $0E: the hidden form
        LD (HL),0
        INC HL
        LD (HL),0
        INC HL
        LD DE,(TGNEW)
        LD (HL),E
        INC HL
        LD (HL),D
        INC HL
        LD (HL),0
        INC HL
        RET
TGNOT:  LD A,(TGTOK)        ; not a plain number: counted if it was a GO TO
        CP T_GOTO
        JR Z,TGN1
        CP T_GOSUB
        RET NZ
TGN1:   PUSH HL
        LD HL,(TGSTART)
        LD A,(HL)
        CP ':'
        JR Z,TGN2
        CP $0D
        JR Z,TGN2
        LD HL,(RENCOUNT)
        INC HL
        LD (RENCOUNT),HL
TGN2:   POP HL
        RET

TGSTART:    DW 0
TGDIGITS:   DB 0
TGDIFF:     DB 0
TGNEW:      DW 0

; RELINE: the lines' own numbers, from RENSTART in steps of RENSTEP.
RELINE: LD HL,(PROG)
        LD DE,(RENSTART)
RL1:    LD A,(HL)
        CP $40
        RET NC
        LD (HL),D
        INC HL
        LD (HL),E
        DEC HL
        PUSH DE
        CALL $19B8          ; NEXT-ONE
        EX DE,HL
        POP DE
        PUSH HL
        LD HL,(RENSTEP)
        ADD HL,DE
        EX DE,HL
        POP HL
        JR RL1

; ---------------------------------------------------------------------------
; Text
; ---------------------------------------------------------------------------
;
; Each text ends with its last character +$80. Character 1 stands for
; DIGITS, a number written out just before.

S_LINE:     DB "Line"," "+$80
S_NEWLINE:  DB "New lin","e"+$80
S_INS:      DB "IN","S"+$80
S_OVR:      DB "OV","R"+$80
S_CAPS:     DB " CAP","S"+$80
S_GRAPH:    DB " GRAP","H"+$80
S_AUTO:     DB " AUT","O"+$80
S_EXTEND:   DB " EXTEN","D"+$80
S_EDITOR:   DB "EDITO","R"+$80

M_TOOLONG:  DB "Line too long to edit: over 512 character","s"+$80
M_FULL:     DB "The line is ful","l"+$80
M_NONUMBER: DB "No number: ENTER runs it, BREAK undoe","s"+$80
M_NOROOM:   DB "4 Out of memor","y"+$80
M_AUTOOFF:  DB "Auto line numbers of","f"+$80
M_NOTFOUND: DB "Not foun","d"+$80
M_NOLINES:  DB "No lines ther","e"+$80
M_DELETED:  DB "Lines delete","d"+$80
M_RENUMBERED: DB "Renumbere","d"+$80
M_NOTFOLLOWED: DB "Renumbered; ",1," GO TO/GO SUB not change","d"+$80
M_TOOBIG:   DB "The numbers would pass 999","9"+$80

P_AUTO:     DB "Auto from,step:"," "+$80
P_GOTO:     DB "Go to line:"," "+$80
P_FIND:     DB "Find:"," "+$80
P_DELETE:   DB "Delete lines from,to:"," "+$80
P_SURE:     DB "Delete ",1," lines? Y or ","N"+$80
P_RENUM:    DB "Renumber from,step:"," "+$80

; ---------------------------------------------------------------------------
; The font: 5x7, 7 bytes a character from $20 to $7F, in bits 7-3, the
; eighth row and the sixth column always empty. Small letters have no
; descenders, so that nothing reaches the row below.
; ---------------------------------------------------------------------------

FONT:
; $20 space
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
; $21 !
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00000000          ; .....
        DB %00100000          ; ..#..
; $22 "
        DB %01010000          ; .#.#.
        DB %01010000          ; .#.#.
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
; $23 #
        DB %01010000          ; .#.#.
        DB %01010000          ; .#.#.
        DB %11111000          ; #####
        DB %01010000          ; .#.#.
        DB %11111000          ; #####
        DB %01010000          ; .#.#.
        DB %01010000          ; .#.#.
; $24 $
        DB %00100000          ; ..#..
        DB %01111000          ; .####
        DB %10100000          ; #.#..
        DB %01110000          ; .###.
        DB %00101000          ; ..#.#
        DB %11110000          ; ####.
        DB %00100000          ; ..#..
; $25 %
        DB %11000000          ; ##...
        DB %11001000          ; ##..#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %10011000          ; #..##
        DB %00011000          ; ...##
; $26 &
        DB %01100000          ; .##..
        DB %10010000          ; #..#.
        DB %10100000          ; #.#..
        DB %01000000          ; .#...
        DB %10101000          ; #.#.#
        DB %10010000          ; #..#.
        DB %01101000          ; .##.#
; $27 '
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
; $28 (
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
; $29 )
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
; $2A *
        DB %00000000          ; .....
        DB %00100000          ; ..#..
        DB %10101000          ; #.#.#
        DB %01110000          ; .###.
        DB %10101000          ; #.#.#
        DB %00100000          ; ..#..
        DB %00000000          ; .....
; $2B +
        DB %00000000          ; .....
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %11111000          ; #####
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00000000          ; .....
; $2C ,
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
; $2D -
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11111000          ; #####
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
; $2E .
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %01100000          ; .##..
; $2F /
        DB %00000000          ; .....
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %10000000          ; #....
        DB %00000000          ; .....
; $30 0
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10011000          ; #..##
        DB %10101000          ; #.#.#
        DB %11001000          ; ##..#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $31 1
        DB %00100000          ; ..#..
        DB %01100000          ; .##..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01110000          ; .###.
; $32 2
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %11111000          ; #####
; $33 3
        DB %11111000          ; #####
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
        DB %00001000          ; ....#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $34 4
        DB %00010000          ; ...#.
        DB %00110000          ; ..##.
        DB %01010000          ; .#.#.
        DB %10010000          ; #..#.
        DB %11111000          ; #####
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
; $35 5
        DB %11111000          ; #####
        DB %10000000          ; #....
        DB %11110000          ; ####.
        DB %00001000          ; ....#
        DB %00001000          ; ....#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $36 6
        DB %00110000          ; ..##.
        DB %01000000          ; .#...
        DB %10000000          ; #....
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $37 7
        DB %11111000          ; #####
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
; $38 8
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $39 9
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01111000          ; .####
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %01100000          ; .##..
; $3A :
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %01100000          ; .##..
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %01100000          ; .##..
        DB %00000000          ; .....
; $3B ;
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %01100000          ; .##..
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
; $3C <
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %10000000          ; #....
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
; $3D =
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11111000          ; #####
        DB %00000000          ; .....
        DB %11111000          ; #####
        DB %00000000          ; .....
        DB %00000000          ; .....
; $3E >
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
; $3F ?
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %00000000          ; .....
        DB %00100000          ; ..#..
; $40 @
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %00001000          ; ....#
        DB %01101000          ; .##.#
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %01110000          ; .###.
; $41 A
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11111000          ; #####
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $42 B
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11110000          ; ####.
; $43 C
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $44 D
        DB %11100000          ; ###..
        DB %10010000          ; #..#.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10010000          ; #..#.
        DB %11100000          ; ###..
; $45 E
        DB %11111000          ; #####
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %11110000          ; ####.
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %11111000          ; #####
; $46 F
        DB %11111000          ; #####
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %11110000          ; ####.
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
; $47 G
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10000000          ; #....
        DB %10111000          ; #.###
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01111000          ; .####
; $48 H
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11111000          ; #####
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $49 I
        DB %01110000          ; .###.
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01110000          ; .###.
; $4A J
        DB %00111000          ; ..###
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %10010000          ; #..#.
        DB %01100000          ; .##..
; $4B K
        DB %10001000          ; #...#
        DB %10010000          ; #..#.
        DB %10100000          ; #.#..
        DB %11000000          ; ##...
        DB %10100000          ; #.#..
        DB %10010000          ; #..#.
        DB %10001000          ; #...#
; $4C L
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %11111000          ; #####
; $4D M
        DB %10001000          ; #...#
        DB %11011000          ; ##.##
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $4E N
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11001000          ; ##..#
        DB %10101000          ; #.#.#
        DB %10011000          ; #..##
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $4F O
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $50 P
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11110000          ; ####.
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
; $51 Q
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10101000          ; #.#.#
        DB %10010000          ; #..#.
        DB %01101000          ; .##.#
; $52 R
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11110000          ; ####.
        DB %10100000          ; #.#..
        DB %10010000          ; #..#.
        DB %10001000          ; #...#
; $53 S
        DB %01111000          ; .####
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %01110000          ; .###.
        DB %00001000          ; ....#
        DB %00001000          ; ....#
        DB %11110000          ; ####.
; $54 T
        DB %11111000          ; #####
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
; $55 U
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $56 V
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01010000          ; .#.#.
        DB %00100000          ; ..#..
; $57 W
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %01010000          ; .#.#.
; $58 X
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01010000          ; .#.#.
        DB %00100000          ; ..#..
        DB %01010000          ; .#.#.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $59 Y
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01010000          ; .#.#.
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
; $5A Z
        DB %11111000          ; #####
        DB %00001000          ; ....#
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %10000000          ; #....
        DB %11111000          ; #####
; $5B [
        DB %01110000          ; .###.
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01110000          ; .###.
; $5C \
        DB %00000000          ; .....
        DB %10000000          ; #....
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
        DB %00001000          ; ....#
        DB %00000000          ; .....
; $5D ]
        DB %01110000          ; .###.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %01110000          ; .###.
; $5E up arrow
        DB %00100000          ; ..#..
        DB %01110000          ; .###.
        DB %10101000          ; #.#.#
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
; $5F _
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11111000          ; #####
; $60 pound sign
        DB %00110000          ; ..##.
        DB %01001000          ; .#..#
        DB %01000000          ; .#...
        DB %11100000          ; ###..
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %11111000          ; #####
; $61 a
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01110000          ; .###.
        DB %00001000          ; ....#
        DB %01111000          ; .####
        DB %10001000          ; #...#
        DB %01111000          ; .####
; $62 b
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10110000          ; #.##.
        DB %11001000          ; ##..#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %11110000          ; ####.
; $63 c
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01110000          ; .###.
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $64 d
        DB %00001000          ; ....#
        DB %00001000          ; ....#
        DB %01101000          ; .##.#
        DB %10011000          ; #..##
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01111000          ; .####
; $65 e
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %11111000          ; #####
        DB %10000000          ; #....
        DB %01110000          ; .###.
; $66 f
        DB %00110000          ; ..##.
        DB %01001000          ; .#..#
        DB %01000000          ; .#...
        DB %11100000          ; ###..
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01000000          ; .#...
; $67 g
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01111000          ; .####
        DB %10001000          ; #...#
        DB %01111000          ; .####
        DB %00001000          ; ....#
        DB %01110000          ; .###.
; $68 h
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10110000          ; #.##.
        DB %11001000          ; ##..#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $69 i
        DB %00100000          ; ..#..
        DB %00000000          ; .....
        DB %01100000          ; .##..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01110000          ; .###.
; $6A j
        DB %00010000          ; ...#.
        DB %00000000          ; .....
        DB %00110000          ; ..##.
        DB %00010000          ; ...#.
        DB %00010000          ; ...#.
        DB %10010000          ; #..#.
        DB %01100000          ; .##..
; $6B k
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10010000          ; #..#.
        DB %10100000          ; #.#..
        DB %11000000          ; ##...
        DB %10100000          ; #.#..
        DB %10010000          ; #..#.
; $6C l
        DB %01100000          ; .##..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01110000          ; .###.
; $6D m
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11010000          ; ##.#.
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $6E n
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10110000          ; #.##.
        DB %11001000          ; ##..#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
; $6F o
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01110000          ; .###.
; $70 p
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11110000          ; ####.
        DB %10001000          ; #...#
        DB %11110000          ; ####.
        DB %10000000          ; #....
        DB %10000000          ; #....
; $71 q
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01111000          ; .####
        DB %10001000          ; #...#
        DB %01111000          ; .####
        DB %00001000          ; ....#
        DB %00001000          ; ....#
; $72 r
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10110000          ; #.##.
        DB %11001000          ; ##..#
        DB %10000000          ; #....
        DB %10000000          ; #....
        DB %10000000          ; #....
; $73 s
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01111000          ; .####
        DB %10000000          ; #....
        DB %01110000          ; .###.
        DB %00001000          ; ....#
        DB %11110000          ; ####.
; $74 t
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %11100000          ; ###..
        DB %01000000          ; .#...
        DB %01000000          ; .#...
        DB %01001000          ; .#..#
        DB %00110000          ; ..##.
; $75 u
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10011000          ; #..##
        DB %01101000          ; .##.#
; $76 v
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01010000          ; .#.#.
        DB %00100000          ; ..#..
; $77 w
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %10101000          ; #.#.#
        DB %10101000          ; #.#.#
        DB %01010000          ; .#.#.
; $78 x
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10001000          ; #...#
        DB %01010000          ; .#.#.
        DB %00100000          ; ..#..
        DB %01010000          ; .#.#.
        DB %10001000          ; #...#
; $79 y
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %10001000          ; #...#
        DB %10001000          ; #...#
        DB %01111000          ; .####
        DB %00001000          ; ....#
        DB %01110000          ; .###.
; $7A z
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %11111000          ; #####
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %11111000          ; #####
; $7B {
        DB %00011000          ; ...##
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %01000000          ; .#...
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00011000          ; ...##
; $7C |
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
; $7D }
        DB %11000000          ; ##...
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %00010000          ; ...#.
        DB %00100000          ; ..#..
        DB %00100000          ; ..#..
        DB %11000000          ; ##...
; $7E ~
        DB %00000000          ; .....
        DB %00000000          ; .....
        DB %01000000          ; .#...
        DB %10101000          ; #.#.#
        DB %00010000          ; ...#.
        DB %00000000          ; .....
        DB %00000000          ; .....
; $7F copyright sign
        DB %01110000          ; .###.
        DB %10001000          ; #...#
        DB %10111000          ; #.###
        DB %10101000          ; #.#.#
        DB %10111000          ; #.###
        DB %10001000          ; #...#
        DB %01110000          ; .###.

