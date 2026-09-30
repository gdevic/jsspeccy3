# BANNER: your words printed down the ZX Printer's roll in letters as
# wide as the paper. Each letter is read from the ROM's character set at
# 15360+8*code; its 8 columns become 16 printed lines, and each of its
# 8 dot rows becomes 4 characters across the line, a full block for a
# dot and spaces for none, the letter's top at the right-hand edge.
10 REM BANNER
20 BORDER 7: PAPER 7: INK 0: CLS
30 DIM s$(2,4): LET s$(2)="\x8f\x8f\x8f\x8f"
40 PRINT AT 1,12; INVERSE 1;" BANNER "
50 PRINT AT 4,0;"Your words, printed down the"'"paper in letters as tall as the"'"roll is wide."
60 PRINT AT 8,0;"Tear the printout off, turn it"'"on its side, and read it."
70 PRINT AT 11,0;"Up to 20 letters."
80 INPUT "Your words? ";w$
90 IF w$="" THEN GO TO 80
100 IF LEN w$>20 THEN LET w$=w$(1 TO 20)
110 PRINT AT 13,0;"Printing:"'w$
120 LPRINT: LPRINT
130 FOR i=1 TO LEN w$: LET c=CODE w$(i): IF c<32 OR c>127 THEN LET c=63
140 PRINT AT 17,0;"Letter ";i;" of ";LEN w$;"   "
150 LET a=15360+8*c
160 FOR x=0 TO 7: LET m=2^(7-x): LET l$=""
170 FOR y=7 TO 0 STEP -1: LET b=INT (PEEK (a+y)/m): LET l$=l$+s$(1+b-2*INT (b/2)): NEXT y
180 LPRINT l$: LPRINT l$
190 NEXT x: NEXT i
200 LPRINT: LPRINT "- - - - - - - - - - - - - - - - "
210 PRINT AT 17,0;"Done. Tear it off!  "
220 PRINT AT 19,0;"Another banner? (Y/N)"
230 PAUSE 0: LET k$=INKEY$: IF k$="y" OR k$="Y" THEN GO TO 20
240 IF k$<>"n" AND k$<>"N" THEN GO TO 230
250 CLS: PRINT "Goodbye."
