std_msgs/Header header
int32 id
string identified_as
string identified_name
float32 identification_confidence

geometry_msgs/Point center
geometry_msgs/Vector3 dimensions
geometry_msgs/Quaternion orientation

float32 volume_m3
float32 surface_area_m2
float32 point_count
float32 cluster_density
float32 aspect_ratio_lw
float32 aspect_ratio_lh
float32 aspect_ratio_wh
float32 sphericity
float32 flatness

float32 size_match_score
float32 shape_match_score
float32 overall_match_score
string match_method

int32 frames_observed
float32 stability_score
builtin_interfaces/Time first_seen
builtin_interfaces/Time last_seen

string[] alternative_matches
float32[] alternative_scores
