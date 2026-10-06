# EDITOR: a full-screen BASIC editor in 42 columns, in machine code. The
# machine code (starter/editor.asm) follows this program on the tape as a
# CODE block for 53248, so the program first moves RAMTOP down under it.
# USR 53251 starts the editor with NEW, so that it opens on an empty
# program, and USR 53248 starts it again keeping the program in memory.
# docs/editor.md tells how to use it.
10 REM EDITOR
20 CLEAR 53247: BORDER 7: PAPER 7: INK 0: CLS
30 PRINT AT 10,4;"THE FULL-SCREEN BASIC EDITOR";AT 13,2;"Loading the machine code..."
40 LOAD ""CODE
50 RANDOMIZE USR 53251
