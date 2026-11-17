package goodfork

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"
	_ "time/tzdata"
)

type Period struct {
	Start int `json:"start"`
	End   int `json:"end"`
}
type HoursException struct {
	Date    string   `json:"date"`
	Periods []Period `json:"periods"`
}
type Schedule struct {
	Timezone   string           `json:"timezone"`
	Week       [][]Period       `json:"week"`
	Exceptions []HoursException `json:"exceptions"`
}

func validPeriods(periods []Period) bool {
	if periods == nil || len(periods) > 4 {
		return false
	}
	end := -1
	for _, p := range periods {
		if p.Start < 0 || p.Start >= 1440 || p.End <= p.Start || p.End > p.Start+1440 || p.Start < end {
			return false
		}
		end = p.End
	}
	return true
}

func (s Schedule) periods(day time.Time) ([]Period, bool) {
	date := day.Format("2006-01-02")
	for _, e := range s.Exceptions {
		if e.Date == date {
			return e.Periods, true
		}
	}
	return s.Week[int(day.Weekday())], false
}

func (s Schedule) validate() error {
	if s.Timezone == "" || len(s.Timezone) > 80 {
		return invalid("Choose the restaurant's IANA timezone.")
	}
	if _, err := time.LoadLocation(s.Timezone); err != nil {
		return invalid("Choose a valid IANA timezone, for example America/New_York.")
	}
	if len(s.Week) != 7 || s.Exceptions == nil || len(s.Exceptions) > 60 {
		return invalid("Supply seven days and at most 60 date exceptions.")
	}
	for day, periods := range s.Week {
		if !validPeriods(periods) {
			return invalid("Use up to four ordered, non-overlapping periods per day.")
		}
		next := s.Week[(day+1)%7]
		if len(periods) > 0 && len(next) > 0 && periods[len(periods)-1].End > 1440+next[0].Start {
			return invalid("Hours overlap across midnight.")
		}
	}
	seen := map[string]bool{}
	for _, e := range s.Exceptions {
		date, err := time.Parse("2006-01-02", e.Date)
		if err != nil || seen[e.Date] || !validPeriods(e.Periods) {
			return invalid("Check each date exception and its service periods.")
		}
		seen[e.Date] = true
		next, override := s.periods(date.AddDate(0, 0, 1))
		if !override && len(e.Periods) > 0 && len(next) > 0 && e.Periods[len(e.Periods)-1].End > 1440+next[0].Start {
			return invalid("Exception hours overlap the next day's service.")
		}
	}
	return nil
}

func (s Schedule) isOpen(at time.Time) bool {
	location, _ := time.LoadLocation(s.Timezone)
	day := at.In(location)
	minute := day.Hour()*60 + day.Minute()
	today, override := s.periods(day)
	for _, p := range today {
		if minute >= p.Start && minute < p.End {
			return true
		}
	}
	if !override {
		yesterday, _ := s.periods(day.AddDate(0, 0, -1))
		for _, p := range yesterday {
			if minute+1440 >= p.Start && minute+1440 < p.End {
				return true
			}
		}
	}
	return false
}

func (s Schedule) legacyHours() []string {
	days := []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	lines := make([]string, 7)
	for day, periods := range s.Week {
		value := "Closed"
		if len(periods) > 0 {
			value = ""
			for i, p := range periods {
				if i > 0 {
					value += ", "
				}
				endHour := (p.End / 60) % 24
				if p.End == 1440 {
					endHour = 24
				}
				value += fmt.Sprintf("%02d:%02d–%02d:%02d", p.Start/60, p.Start%60, endHour, p.End%60)
				if p.End > 1440 {
					value += " (+1)"
				}
			}
		}
		lines[day] = days[day] + " " + value
	}
	return lines
}

func (a *API) previewHours(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Schedule Schedule `json:"schedule"`
		Date     string   `json:"date"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if err := body.Schedule.validate(); err != nil {
		return err
	}
	var allowed bool
	err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM restaurant_owners o JOIN places d ON d.id=o.place_id
        WHERE o.place_id=$1 AND o.person_id=$2 AND d.status='published')`, r.PathValue("id"), viewer).Scan(&allowed)
	if err := existsResult(err, allowed); err != nil {
		return err
	}
	at := time.Now()
	if body.Date != "" {
		date, err := time.Parse("2006-01-02", body.Date)
		if err != nil {
			return invalid("Use YYYY-MM-DD for the preview date.")
		}
		location, _ := time.LoadLocation(body.Schedule.Timezone)
		at = time.Date(date.Year(), date.Month(), date.Day(), 12, 0, 0, 0, location)
	}
	location, _ := time.LoadLocation(body.Schedule.Timezone)
	periods, _ := body.Schedule.periods(at.In(location))
	return send(w, http.StatusOK, map[string]any{"open": body.Schedule.isOpen(at), "asOf": at, "timezone": body.Schedule.Timezone, "periods": periods, "week": body.Schedule.legacyHours()})
}

func parseSchedule(raw json.RawMessage) (*Schedule, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var schedule Schedule
	if err := json.Unmarshal(raw, &schedule); err != nil {
		return nil, invalid("Check the structured hours.")
	}
	if err := schedule.validate(); err != nil {
		return nil, err
	}
	sort.Slice(schedule.Exceptions, func(i, j int) bool { return schedule.Exceptions[i].Date < schedule.Exceptions[j].Date })
	return &schedule, nil
}
