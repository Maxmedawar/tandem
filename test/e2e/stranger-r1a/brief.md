You have never seen this software before. Your task: follow its README to get a working local hub and one session on a fresh computer, then stop.

How you reach that computer: ONLY through this command, which you run with your shell tool:

    sh <CHECK> exec <RUN> '<command>'

Each call runs one command on that computer, in its home folder, as its own user, and prints the output. Nothing carries over between calls except files (each call starts again in the home folder), so join steps with `&&` or `cd <folder> && ...` when you need to.

What is already there:
- The README is `README.md` in the home folder. Read it with: `sh <CHECK> exec <RUN> 'cat README.md'`
- The code is already in the folder `tandem` in the home folder. The README's clone step is done; start from the step after it.

Rules:
- You may run any command the README gives you, and read the output and error messages of your commands.
- You may NOT open any other file of the `tandem` folder to learn how it works, read any file on your own computer, search the web, or use any tool other than your shell tool running the command above.
- Nobody will answer questions.
- You have 15 minutes from now.

When the README's own check passes, or when you are stuck, stop and write your report in this form:

    RESULT DONE        (or: RESULT STUCK)
    MINUTES <how many minutes you took>
    GAP <README heading> | <what the README said or did not say> | <what happened>

Write one GAP line per problem you met. If there was none, write `GAP none`.
