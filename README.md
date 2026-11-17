# Scout Scraper

Pulls every post from scouted-today.pk for a given day, with its thumbnail, post ID, the link in the post, and the linkvertise.com URL that link redirects to. It can also do this automatically once a day.

## Requirements

[Node.js](https://nodejs.org) 18 or newer (the LTS download is fine). Nothing else to install.

## Start it

Double-click **`Start Scout Scraper.bat`**. Your browser opens to http://localhost:3000.
Keep the black window open while you use it; close it to stop the scraper.

Double-clicking it again while it's already running just opens the page.

## Using it

- **Get posts:** pick a date and click *Get posts*. Each scrape is saved in the `data` folder.
- **Load saved:** reopen any day you've already scraped.
- **Download CSV:** export the current table.
- **Thumbnails:** click one to open it. Scroll or pinch to zoom, drag to move around, double-click to zoom in or reset. Click or press Esc to close.

## Daily auto-run

In the *Auto-run daily* box, tick **Enabled**, choose a time and click **Save**. Each day at that time it scrapes that day's posts and saves them.

It only runs while the scraper is running. To keep it running without thinking about it, double-click **`Start with Windows (toggle).bat`** once. The scraper will then start minimized every time you log in. Run the same file again to turn that off.

If the computer is asleep at the set time, the run happens as soon as it wakes up (same day). If the computer is off for the whole day, that day is skipped. Just scrape it by hand later.

## Files

| File | What it is |
|---|---|
| `Start Scout Scraper.bat` | Launcher |
| `Start with Windows (toggle).bat` | Turns start-at-login on/off |
| `server.js` | Scraper, scheduler and local web server |
| `index.html` | The page you use |
| `data/` | Saved scrapes, one JSON file per day |
| `schedule.json` | Your auto-run settings (created when you save them) |

## Notes

- Dates follow the site's clock (about UTC+1). The auto-run time follows your computer's clock.
- The page is only reachable from this computer.
- To move it to another computer, copy the whole folder.
