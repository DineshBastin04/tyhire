from app.models.job import Job, WorkMode


def check_knockout(profile: dict, job: Job) -> tuple[bool, list[str]]:
    reasons: list[str] = []

    years = profile.get("total_years_experience")
    if job.min_years_experience is not None and years is not None:
        if years < job.min_years_experience:
            reasons.append(
                f"Requires {job.min_years_experience}+ yrs experience, candidate has {years}"
            )

    # A remote role shouldn't knock candidates out for location at all, regardless of
    # allowed_locations — that field only matters for hybrid/onsite roles.
    if job.work_mode != WorkMode.remote and job.allowed_locations:
        location = (profile.get("current_location") or "").strip().lower()
        allowed = [loc.strip().lower() for loc in job.allowed_locations]
        # Substring match, not exact equality — extracted locations often carry extra
        # context (e.g. "Bangalore, India") that would otherwise wrongly knock out a
        # candidate whose city is actually on the allowed list.
        if location and not any(a in location or location in a for a in allowed):
            reasons.append(f"Location '{profile.get('current_location')}' not in allowed list")

    # Resumes rarely state these outright — profile.notice_period_days/expected_salary is
    # populated either from the parser (if actually mentioned) or manually by HR afterwards
    # via POST /candidates/{id}/screening-details. Skipped entirely when either side is
    # unset, same convention as every other knockout check here.
    notice_period_days = profile.get("notice_period_days")
    if job.max_notice_period_days is not None and notice_period_days is not None:
        if notice_period_days > job.max_notice_period_days:
            reasons.append(
                f"Notice period is {notice_period_days} days, role allows up to "
                f"{job.max_notice_period_days}"
            )

    expected_salary = profile.get("expected_salary")
    if job.salary_band_max is not None and expected_salary is not None:
        if expected_salary > job.salary_band_max:
            reasons.append(
                f"Expected salary {expected_salary} exceeds the role's budget of "
                f"{job.salary_band_max}"
            )

    return (len(reasons) > 0, reasons)
