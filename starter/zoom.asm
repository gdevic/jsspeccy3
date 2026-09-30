; ZOOM's machine code: the Mandelbrot set in the screen's 32 by 22 colour
; squares, fast enough to zoom into, and the table of squares it works
; with. tools/gen-starter.js assembles it (tools/z80asm.js) and saves it
; on the tape as a CODE block after the BASIC, which loads it.
;
; Numbers are 16-bit two's complement fixed point with 12 fraction bits:
; 4096 is 1.0. Each step of z = z*z + c needs a*a, b*b and 2ab, and all
; three come from one table of squares, T(m) = m*m/4096 for m = 0 to
; 16383, as 2|a||b| = (|a|+|b|)^2 - a*a - b*b. A point has escaped once
; |a|+|b| reaches 4, or a*a+b*b reaches 4, which also keeps every sum
; inside 16 bits.
;
; BASIC sets X0, Y0, STEP and MAXIT, then calls RENDER (USR 61451) to
; draw; MKTAB (USR 61448) makes the table once, first. Neither touches IY
; or HL', which BASIC needs kept. The code sits above 32768, where the
; screen does not slow the processor down, and the table below it.

        ORG 61440

X0:     DW 0                ; the real part at the left-hand column
Y0:     DW 0                ; the imaginary part at the top row
STEP:   DW 0                ; from one square to the next
MAXIT:  DB 0                ; steps before a point counts as inside the set
        DB 0
        JP MKTAB            ; 61448
        JP RENDER           ; 61451

; A square's colour by how many steps its point took to escape: paper
; colours, the ink black, so that the flashing cursor shows on every one.
PAL:    DB 8,72,40,104,32,96,48,112,120,56,16,80,24,88,40,104

TABLE   EQU $7000           ; T(m) at TABLE+2m, up to $EFFF

; MKTAB: T(m) for every m, with m*m kept as its whole part (HL) and its
; remainder (DE) in units of 1/4096, stepping on by 2m+1, whose whole
; part is INCQ and remainder BC. The alternate BC counts the entries.
MKTAB:  LD IX,TABLE
        LD HL,0
        LD DE,0
        LD BC,1
        XOR A
        LD (INCQ),A
        EXX
        LD BC,16384
        EXX
MK1:    LD (IX+0),L
        LD (IX+1),H
        INC IX
        INC IX
        EX DE,HL
        ADD HL,BC           ; the remainders add
        EX DE,HL
        LD A,(INCQ)
        ADD A,L             ; and the whole parts
        LD L,A
        JR NC,MK2
        INC H
MK2:    LD A,D              ; a remainder of 4096 or more carries into the whole part
        CP $10
        JR C,MK3
        SUB $10
        LD D,A
        INC HL
MK3:    INC BC              ; 2m+1 goes up by 2
        INC BC
        LD A,B
        CP $10
        JR C,MK4
        SUB $10
        LD B,A
        LD A,(INCQ)
        INC A
        LD (INCQ),A
MK4:    EXX
        DEC BC
        LD A,B
        OR C
        EXX
        JR NZ,MK1
        RET

; RENDER: each square's colour into the attributes, row by row from the
; top. SPACE stops it at the end of a row.
RENDER: LD HL,$5800
        LD (APTR),HL
        LD HL,(Y0)
        LD (CY),HL
        LD A,22
        LD (ROWS),A
RN1:    LD HL,(X0)
        LD (CX),HL
        LD A,32
        LD (COLS),A
RN2:    CALL ITER
        LD HL,(APTR)
        LD (HL),A
        INC HL
        LD (APTR),HL
        LD HL,(CX)
        LD DE,(STEP)
        ADD HL,DE
        LD (CX),HL
        LD A,(COLS)
        DEC A
        LD (COLS),A
        JR NZ,RN2
        LD HL,(CY)
        LD DE,(STEP)
        OR A
        SBC HL,DE
        LD (CY),HL
        LD A,$7F            ; SPACE, in the half-row from B to SPACE
        IN A,($FE)
        RRA
        RET NC
        LD A,(ROWS)
        DEC A
        LD (ROWS),A
        JR NZ,RN1
        RET

; ITER: A = the colour of the point CX + i CY. B counts the steps down
; from MAXIT, and bit 7 of C is the sign of a*b. Every 8 steps z is kept
; in SA and SB, and a z that comes back to it exactly has settled into a
; cycle, which only a point inside the set does: in fixed point that
; happens soon, so the black squares take a few steps rather than MAXIT.
; Before any step, a point in the main cardioid or the disc left of it is
; inside: with p = x - 1/4 and q = p*p + y*y, the cardioid is where
; q*(q+p) <= y*y/4, that is (2q+p)^2 <= q, and the disc where
; (x+1)^2 + y*y < 1/16. Only a q under 1 can be in the cardioid.
ITER:   LD HL,(CY)
        CALL ABS
        CALL LOOKUP
        LD (Y2),HL          ; y*y
        LD HL,(CX)
        LD DE,-1024
        ADD HL,DE           ; p
        PUSH HL
        CALL ABS
        CALL LOOKUP         ; p*p
        LD DE,(Y2)
        ADD HL,DE           ; q
        POP DE
        LD A,H
        CP $10
        JR NC,NOTC
        PUSH HL
        ADD HL,HL
        ADD HL,DE           ; 2q+p
        CALL ABS
        CALL LOOKUP
        EX DE,HL
        POP HL
        OR A
        SBC HL,DE
        JP NC,IN            ; (2q+p)^2 <= q: in the cardioid
NOTC:   LD HL,(CX)
        LD DE,4096
        ADD HL,DE           ; x+1
        CALL ABS
        CALL LOOKUP
        LD DE,(Y2)
        ADD HL,DE
        LD DE,256
        OR A
        SBC HL,DE
        JP C,IN             ; in the disc
        LD HL,(CX)
        LD (ZA),HL
        LD HL,(CY)
        LD (ZB),HL
        LD HL,$8000
        LD (SA),HL
        LD A,1
        LD (PER),A
        LD A,(MAXIT)
        LD B,A
IT1:    LD HL,(ZA)
        LD C,H
        CALL ABS
        EX DE,HL            ; DE = |a|
        LD HL,(ZB)
        LD A,H
        XOR C
        LD C,A
        CALL ABS            ; HL = |b|
        PUSH HL
        ADD HL,DE           ; |a|+|b|
        LD A,H
        CP $40
        JR NC,OUT1          ; 4 or more: escaped
        CALL LOOKUP
        LD (TS),HL          ; (|a|+|b|)^2
        POP HL
        CALL LOOKUP
        LD (B2),HL          ; b*b
        EX DE,HL
        CALL LOOKUP
        LD (A2),HL          ; a*a
        ADD HL,DE
        LD A,H
        CP $40
        JR NC,OUT           ; a*a+b*b is 4 or more: escaped
        LD HL,(A2)
        OR A
        SBC HL,DE
        LD DE,(CX)
        ADD HL,DE
        LD (ZA),HL          ; the new a: a*a - b*b + x
        LD HL,(TS)
        LD DE,(A2)
        OR A
        SBC HL,DE
        LD DE,(B2)
        OR A
        SBC HL,DE           ; 2|a||b|
        BIT 7,C
        CALL NZ,NEGHL
        LD DE,(CY)
        ADD HL,DE
        LD (ZB),HL          ; the new b: 2ab + y
        LD DE,(SB)
        OR A
        SBC HL,DE
        JR NZ,IT4
        LD HL,(ZA)
        LD DE,(SA)
        OR A
        SBC HL,DE
        JR Z,IN             ; back where it was: inside
IT4:    LD A,(PER)
        DEC A
        JR NZ,IT5
        LD HL,(ZA)
        LD (SA),HL
        LD HL,(ZB)
        LD (SB),HL
        LD A,8
IT5:    LD (PER),A
        DEC B
        JP NZ,IT1
IN:     LD A,7              ; inside: black paper, white ink
        RET
OUT1:   POP HL
OUT:    LD A,(MAXIT)        ; escaped after MAXIT-B+1 steps
        SUB B
        AND 15
        LD HL,PAL
        ADD A,L
        LD L,A
        LD A,(HL)
        RET

; HL = T(HL)
LOOKUP: ADD HL,HL
        LD A,H
        ADD A,TABLE/256
        LD H,A
        LD A,(HL)
        INC HL
        LD H,(HL)
        LD L,A
        RET

; HL = |HL|, and NEGHL: HL = -HL
ABS:    BIT 7,H
        RET Z
NEGHL:  XOR A
        SUB L
        LD L,A
        SBC A,A
        SUB H
        LD H,A
        RET

CX:     DW 0
CY:     DW 0
ZA:     DW 0
ZB:     DW 0
TS:     DW 0
A2:     DW 0
B2:     DW 0
Y2:     DW 0
SA:     DW 0
SB:     DW 0
PER:    DB 0
APTR:   DW 0
ROWS:   DB 0
COLS:   DB 0
INCQ:   DB 0
